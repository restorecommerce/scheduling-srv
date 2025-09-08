import * as _ from 'lodash-es';
import { errors } from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import {
  AuthZAction,
  DecisionResponse,
  Operation,
  PolicySetRQResponse,
  CtxResource,
  CustomQueryArgs
} from '@restorecommerce/acs-client';
import {
  JobServiceImplementation as SchedulingServiceServiceImplementation,
  JobFailed, JobDone, DeepPartial, JobList, JobListResponse,
  Backoff_Type, JobOptions_Priority, JobReadRequest, JobReadRequest_SortOrder,
  JobResponse, Job,
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job.js';
import { createClient, RedisClientType } from 'redis';
import { NewJob, Priority } from './types.js';
import pkg, { CronExpression } from 'cron-parser';
import { _filterJobData, _filterJobOptions, _filterQueuedJob, checkAccessRequest, decomposeError, marshallProtobufAny } from './utilts.js';
import * as uuid from 'uuid';
import { Logger } from 'winston';
import { Response_Decision } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control.js';
import { Attribute } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/attribute.js';
import {
  DeleteRequest,
  DeleteResponse,
  ResourceListResponse
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { Queue, QueueOptions, Job as BullJob } from 'bullmq';
import { Status } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/status.js';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth.js';
import { Meta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/meta.js';

const { CronExpressionParser } = pkg;
const JOB_DONE_EVENT = 'jobDone';
const JOB_FAILED_EVENT = 'jobFailed';
const DEFAULT_CLEANUP_COMPLETED_JOBS = 604800000; // 7 days in miliseconds
const COMPLETED_JOB_STATE = 'completed';
const FAILED_JOB_STATE = 'failed';
const QUEUE_CLEANUP = 'queueCleanup';

/**
 * A job scheduling service.
 */
export class SchedulingService implements SchedulingServiceServiceImplementation {
  public queuesList: Queue[];
  protected queuesConfigList: any;
  protected defaultQueueName: string;
  protected resourceEventsEnabled: boolean;
  protected canceledJobs: Set<string>;
  protected repeatJobIdRedisClient: RedisClientType<any, any>;
  protected techUser: Subject;

  constructor(
    protected readonly jobEvents: kafkaClient.Topic,
    protected readonly redisConfig: any,
    protected readonly logger: Logger,
    protected readonly redisClient: RedisClientType<any, any>,
    protected readonly bullOptions: any,
    protected readonly cfg: any,
  ) {
    this.resourceEventsEnabled = true;
    this.queuesList = [];
    this.queuesConfigList = [];
    this.techUser = cfg.get('authorization:techUser');

    const repeatJobIdCfg = cfg.get('redis');
    repeatJobIdCfg.database = cfg.get('redis:db-indexes:db-repeatJobId');
    this.repeatJobIdRedisClient = createClient(repeatJobIdCfg);
    this.repeatJobIdRedisClient.on(
      'error',
      (err) => logger?.error('Redis client error in repeatable job store', decomposeError(err)));
    this.repeatJobIdRedisClient.connect().then((data) => {
      logger?.info('Redis client connection for repeatable job store successful');
    }).catch(err => logger?.error('Redis client error for repeatable job store', decomposeError(err)));

    this.canceledJobs = new Set<string>();

    // Read Queue Configuration file and find first queue which has "default": true,
    // then save it to defaultQueueName
    const queuesCfg = this.cfg.get('queue');
    if (_.isEmpty(queuesCfg)) {
      this.logger?.error('Queue configuration not found!');
      throw new Error('Queue configuration not found!');
    }
    let defaultTrueExists = false;
    for (const queueCfg of queuesCfg) {
      // Find configuration which has default=true
      if (queueCfg.default == true) {
        defaultTrueExists = true;
        this.defaultQueueName = queueCfg.name;
        break;
      }
    }
    if (!defaultTrueExists) {
      this.logger?.error('Queue default configuration not found!');
      throw new Error('Queue default configuration not found!');
    }

    // Create Queues
    for (const queueCfg of queuesCfg) {
      const prefix = queueCfg.name;
      const rateLimiting = queueCfg.rateLimiting;
      const advancedSettings = queueCfg.advancedSettings;

      const queueOptions: QueueOptions = {
        connection: {
          ...redisConfig,
        }
      };

      // Create Queue Configuration - Add Rate Limiting if enabled
      if (!_.isEmpty(rateLimiting) && rateLimiting.enabled == true) {
        this.logger?.info(`Queue: ${queueCfg.name} - Rate limiting is ENABLED.`);
      }

      if (!_.isEmpty(advancedSettings)) {
        queueOptions.settings = {
          ...advancedSettings,
        };
      }

      const redisURL = new URL((queueOptions.connection as any).url);

      if ('keyPrefix' in queueOptions.connection) {
        delete queueOptions.connection.keyPrefix;
      }

      const queue = new Queue(prefix, {
        ...queueOptions,
        connection: {
          ...queueOptions.connection as any,
          host: redisURL.hostname,
          port: Number.parseInt(redisURL.port)
        }
      });
      this.queuesList.push(queue);

      // Add Queue Configurations
      const queueCfgObj = {
        name: queueCfg.name,
        concurrency: queueCfg.concurrency,
        default: queueCfg.default,
        runMissedScheduled: queueCfg.runMissedScheduled
      };
      this.queuesConfigList.push(queueCfgObj);
    }
  }

  private catchOperationStatus(error: any, message?: string): ResourceListResponse {
    this.logger?.error(message ?? error?.message, decomposeError(error));
    return {
      total_count: 0,
      operation_status: {
        code: Number.isInteger(error?.code) ? error.code : 500,
        message: error?.message ?? error?.msg ?? error?.details ?? message,
      },
    };
  }

  private catchStatus(id: string, error: any, message?: string): Status {
    this.logger?.error(message ?? error?.message, decomposeError(error));
    return {
      id,
      code: Number.isInteger(error?.code) ? error.code : 500,
      message: error?.message ?? error?.msg ?? error?.details ?? message,
    };
  }

  /**
   * Start handling the job queue, job scheduling and
   * managing job events.
   */
  async start(): Promise<any> {
    const logger = this.logger;
    const events = [JOB_DONE_EVENT, JOB_FAILED_EVENT];
    for (const eventName of events) {
      // A Scheduling Service Event Listener
      await this.jobEvents.on(
        eventName,
        async (msg: any, ctx: any, config: any, eventName: string): Promise<any> => {
          const job = msg;
          // Match Job Type to Queue Name, else use Default Queue
          const queue = this.queuesList?.find(q => q.name === job.type)
            ?? this.queuesList?.find(q => q.name === this.defaultQueueName);

          if (eventName === JOB_FAILED_EVENT) {
            logger?.error(`job@${job.type}#${job.id} failed with error #${job.error}`,
              _filterQueuedJob<JobFailed>(job, this.logger));
          } else if (eventName === JOB_DONE_EVENT) {
            logger?.verbose(`job#${job.id} done`, _filterQueuedJob<JobDone>(job, this.logger));
          }

          logger?.info('Received Job event', { event: eventName });
          logger?.info('Job details', job);
          const jobData: any = await queue.getJob(job.id).catch(error => {
            logger?.error('Error retrieving job ${job.id} from queue', decomposeError(error));
          });

          if (job?.delete_scheduled) {
            await queue.removeRepeatable(jobData.name, jobData.opts.repeat);
          }
        }
      );
    }

    // Initialize Event Listeners for each Queue
    for (const queue of this.queuesList) {
      queue.on('error', (error) => {
        logger?.error('queue error', decomposeError(error));
      });
      queue.on('waiting', (job) => {
        logger?.verbose(`job#${job.id} scheduled`, job);
      });
      queue.on('removed', (job) => {
        logger?.verbose(`job#${job.id} removed`, job);
      });
      queue.on('progress', (job) => {
        logger?.verbose(`job#${job.id} progress`, job);
      });
    }

    // If the scheduling service goes down and if there were
    // recurring jobs which have missed schedules then
    // we will need to reschedule it for those missing intervals.
    await this._rescheduleMissedJobs();
  }

  /**
   * To reschedule the missed recurring jobs upon service restart
   */
  private async _rescheduleMissedJobs(): Promise<JobListResponse[]> {
    // for jobs created via Kafka currently there are no acs checks
    const result: BullJob[] = [];
    const logger = this.logger;
    // Get the jobs
    for (const queueCfg of this.queuesConfigList) {
      // If enabled in the config, or the config is missing,b
      // Reschedule the missed jobs, else skip.
      const queue = this.queuesList?.find(q => q.name === queueCfg.name);
      if (queueCfg?.runMissedScheduled?.toString() === 'true') {
        await queue.getJobs(['active', 'delayed', 'repeat']).then(jobs => {
          result.push(...(jobs?.filter(Boolean) ?? []));
        }).catch((error: any) => {
          logger?.error(
            'Error reading jobs to reschedule the missed recurring jobs',
            decomposeError(error)
          );
        });
      }
    }
    const pomises = result.map(async job => {
      let lastRunTime;
      // get the last run time for the job, we store the last run time only
      // for recurring jobs
      if (job?.name) {
        try {
          lastRunTime = await this.redisClient.get(job.name);
        } catch (error: any) {
          this.logger?.error(
            'Error reading the last run time for job type:',
            { name: job.name }, decomposeError(error)
          );
        }
      }
      // we store lastRunTime only for recurring jobs and if it exists check
      // cron interval and schedule immediate jobs for missed intervals
      this.logger?.info(`Job overdue - Last run time of Job ${job?.name} was:`, lastRunTime);
      if (lastRunTime) {
        // convert redis string value to object and get actual time value
        try {
          lastRunTime = JSON.parse(lastRunTime);
        }
        catch (error: any) {
          this.logger?.error(
            'Error parsing lastRunTime',
            { lastRunTime }, decomposeError(error)
          );
        }

        if ((job?.opts?.repeat as any)?.pattern && lastRunTime?.time) {
          const options = {
            currentDate: new Date(lastRunTime.time),
            endDate: new Date(),
            iterator: true
          };
          try {
            const intervalTime = CronExpressionParser.parse((job.opts.repeat as any).pattern, options);
            while (intervalTime?.hasNext()) {
              const nextInterval = intervalTime.next();
              // schedule it as one time job for now or immediately
              const data = {
                payload: marshallProtobufAny({
                  value: {
                    time: nextInterval.toString()
                  }
                })
              };
              const currentTime = new Date();
              const when = new Date(currentTime.setSeconds(currentTime.getSeconds() + 2)).toISOString();
              const immediateJob: Job = {
                type: job.name,
                data,
                // give a delay of 2 sec between each job
                // to avoid time out of queued jobs
                when,
                options: {}
              };
              return await this.create({
                items: [immediateJob],
                total_count: 0,
                subject: this.techUser,
              });
            }
          }
          catch (error) {
            this.logger?.error('Error parsing cron expression running missed schedules', decomposeError(error));
          }
        }
      }
    });
    return await Promise.all(pomises);
  }

  /**
   * Disabling of CRUD events.
   */
  disableEvents(): void {
    this.resourceEventsEnabled = false;
  }

  /**
   * Enabling of CRUD events.
   */
  enableEvents(): any {
    this.resourceEventsEnabled = true;
  }

  _validateJob(job: NewJob): NewJob {
    if (_.isNil(job.type)) {
      throw new errors.InvalidArgument('Job type not specified.');
    }

    if (!job.options) {
      job.options = {};
    }

    if (job.when) {
      // If the jobSchedule time has already lapsed then do not schedule the job
      const jobScheduleTime = new Date(job.when).getTime();
      const currentTime = new Date().getTime();
      if (jobScheduleTime < currentTime) {
        throw new errors.InvalidArgument('Cannot schedule a job for an elapsed time');
      }

      job.options.delay = jobScheduleTime - currentTime;
    }

    if (job.options.backoff && typeof job.options.backoff !== 'number') {
      if (typeof job.options.backoff.type === 'number') {
        job.options.backoff.type = Object.keys(Backoff_Type)[job.options.backoff.type];
      }
      job.options.backoff.type = job.options.backoff.type.toLowerCase();
    }

    if (job.options.priority && typeof job.options.priority === 'string') {
      job.options.priority = JobOptions_Priority[job.options.priority] as any;
    }

    if (_.isEmpty(job.data)) {
      throw new errors.InvalidArgument('No job data specified.');
    }

    job.data = _filterJobData(job.data, false, this.logger);

    return job;
  }

  /**
   * get next job execution time in mili seconds
   * @param millis
   * @param opts
   */
  getNextMillis(millis: number, opts: any) {
    if (opts?.every) {
      return Math.floor(millis / opts.every) * opts.every + opts.every;
    }

    const currentDate =
      opts?.startDate && new Date(opts.startDate) > new Date(millis)
        ? new Date(opts.startDate)
        : new Date(millis);
    const interval = CronExpressionParser.parse(
      opts.cron,
      _.defaults(
        {
          currentDate
        },
        opts
      )
    );

    try {
      return interval.next().getTime();
    } catch (e) {
      this.logger?.error('Error getting next job execution time');
    }
  }

  /**
   * store the mapping from repeateKey to external interface SCS job Id, and
   * also the mapping other way around i.e. from SCS job Id to repeatKey (needed for read operations)
   * @param name - job name
   * @param repeat - job repeate options
   * @param jobId - job id
   */
  async storeRepeatKey(repeatId: string, scsJobId: string, options: any) {
    try {
      if (repeatId && scsJobId) {
        this.logger?.info('Repeat key mapped to external SCS JobId', { repeatId, scsJobId });
        await this.repeatJobIdRedisClient.set(repeatId, scsJobId);
        const jobIdData = { repeatId, options };
        await this.repeatJobIdRedisClient.set(scsJobId, JSON.stringify(jobIdData));
      }
    } catch (error: any) {
      this.logger?.error('Error storing repeatKey to redis', decomposeError(error));
    }
  }

  private idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  /**
   * Create and queue jobs.
   * @param {any} call RPC call argument
   * @param {any} ctx RPC context
   */
  async create(request: JobList, ctx?: any): Promise<DeepPartial<JobListResponse>> {
    const jobListResponse: JobListResponse = { items: [], operation_status: { code: 0, message: '' }, total_count: 0 };
    const subject = request.subject;
    if (!request?.items?.length) {
      return {
        items: [],
        total_count: 0,
        operation_status: {
          code: 400,
          message: 'Missing items in create request'
        }
      };
    }

    await this.createMetadata(request.items, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = request?.items?.map((job) => {
        const { data, ...resource } = job;
        return resource;
      });
      acsResponse = await checkAccessRequest(ctx, [{
        resource: 'job',
        id: request.items.map(item => item.id)
      }], AuthZAction.CREATE, Operation.isAllowed);
    } catch (err: any) {
      return this.catchOperationStatus(err, 'Error requesting access-control-srv for create meta data');
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return {
        items: [],
        total_count: 0,
        operation_status: acsResponse.operation_status
      };
    }

    const jobs: NewJob[] = [];
    for (const job of request?.items || []) {
      try {
        jobs.push(this._validateJob(job as any));
      } catch (err: any) {
        this.logger?.error('Error validating job', job, decomposeError(err));
        jobListResponse.items.push({
          status: {
            id: job.id,
            code: 400,
            message: err.message
          }
        });
      }
    }

    const result: BullJob[] = [];
    // Scheduling jobs
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      // if not jobID is specified generate a UUID
      if (!job.id) {
        job.id = this.idGen();
      }

      // map the id to jobId as needed in JobOpts for bull
      if (job?.id) {
        // check if jobID already exists then map it as already exists error
        const existingJobId = await this.getRedisValue(job.id);
        if (existingJobId) {
          // read job to check if data exists
          const jobData = await this.read(JobReadRequest.fromPartial({
            filter: {
              job_ids: [job.id]
            },
            subject
          }), ctx);
          if ((jobData?.items as any)[0]?.payload) {
            jobListResponse.items.push({
              status: {
                id: job.id,
                code: 403,
                message: `Job with ID ${job.id} already exists`
              }
            });
            continue;
          }
        }
        if (!job?.options) {
          job.options = { jobId: job.id };
        } else {
          job.options.jobId = job.id;
        }
        if (job?.options?.repeat) {
          (job as any).options.repeat.jobId = job.id;
        }
      }

      if (!job.data.meta) {
        const now = new Date();
        const metaObj: Meta = {
          created: now,
          modified: now,
          modified_by: '',
          owners: []
        };
        Object.assign(job.data, { meta: metaObj });
      }
      // if only owners are specified in meta
      if (job.data.meta && (!job.data.meta.created || !job.data.meta.modified)) {
        job.data.meta.created = new Date();
        job.data.meta.modified = new Date();
      }
      if (job?.data?.meta) {
        job.data.meta.created_by = subject?.id;
        job.data.meta.modified_by = subject?.id;
      }

      if (job?.data?.payload?.value) {
        job.data.payload.value = job.data.payload.value.toString() as any;
      }

      // convert enum priority back to number as it's expected by bull
      if (job?.options?.priority) {
        job.options.priority = typeof job.options.priority === 'number' ? job.options.priority : Priority[job.options.priority] as unknown as number;
      }

      // if its a repeat job and tz is empty delete the key (else cron parser throws an error)
      if (job?.options?.repeat?.tz === '') {
        delete job.options.repeat.tz;
      }

      const bullOptions = {
        ...job.options
      };

      if ((bullOptions as any).timeout === 1) {
        delete (bullOptions as any).timeout;
      }

      // Match the Job Type with the Queue Name and add the Job to this Queue.
      // If there is no match, add the Job to the Default Queue
      let queue = _.find(this.queuesList, { name: job?.queue_name });
      if (_.isEmpty(queue)) {
        queue = _.find(this.queuesList, { name: this.defaultQueueName });
      }
      const submittedJob = await queue.add(job.type, job.data, bullOptions);
      if (submittedJob?.id?.startsWith('repeat:')) {
        const repeatJobId = submittedJob?.id?.split(':')[1];
        await this.storeRepeatKey(repeatJobId, job.id, job.options);
      } else if (submittedJob?.id) {
        // future job with when
        await this.storeRepeatKey(submittedJob.id, job.id, job.options);
      }
      this.logger?.verbose(`job@${job.type} created`, job);
      result.push(submittedJob);
    }

    for (const job of result) {
      const jobId = job.id as string;
      if (jobId.startsWith('repeat:')) {
        const repeatKey = jobId.split(':')[1];
        job.id = await this.getRedisValue(repeatKey);
      }
    }

    for (const job of result) {
      const when = job?.opts?.delay ? new Date(job?.opts?.delay).toString() : '';
      jobListResponse.items.push({
        payload: {
          id: job.id as string,
          type: job.name,
          queue_name: job?.queueName,
          data: _filterJobData(job.data, true, this.logger),
          options: _filterJobOptions(job.opts) as any,
          when
        },
        status: {
          id: (job?.id)?.toString(),
          code: 200,
          message: 'success'
        }
      });
    }
    const jobList = {
      items: result.map(job => ({
        id: job.id,
        type: job.name,
        data: _filterJobData(job.data, true, this.logger),
        options: _filterJobOptions(job.opts)
      })),
      total_count: result.length
    };

    if (this.resourceEventsEnabled) {
      await this.jobEvents.emit('jobsCreated', jobList);
    }

    jobListResponse.operation_status = jobListResponse.items?.some(
      item => item.status?.code !== 200
    ) ? { code: 207, message: 'Multi Status!' }
      : { code: 200, message: 'success' };
    return jobListResponse;
  }

  private filterByOwnerShip(customArgsObj: CustomQueryArgs, result: BullJob[]): BullJob[] {
    // applying filter based on custom arguments (filterByOwnerShip)
    const filteredResult = new Array<BullJob>();
    const customArgs = customArgsObj?.custom_arguments;
    if (customArgs?.value) {
      let customArgsFilter;
      try {
        customArgsFilter = JSON.parse(customArgs.value.toString());
      } catch (error: any) {
        this.logger?.error('Error parsing custom query arguments', decomposeError(error));
      }
      if (customArgsFilter?.length === 0) {
        return [];
      }
      if (!Array.isArray(customArgsFilter)) {
        customArgsFilter = [customArgsFilter];
      }
      for (const customArgObj of customArgsFilter) {
        const ownerIndicatorEntity = customArgObj?.entity;
        const ownerValues = customArgObj?.instance;
        const ownerIndictaorEntURN = this.cfg.get('authorization:urns:ownerIndicatoryEntity');
        const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
        const filteredResp = result.filter(job => {
          if (job?.data?.meta?.owners?.length > 0) {
            for (const owner of job.data.meta.owners) {
              if (owner?.id === ownerIndictaorEntURN && owner?.value === ownerIndicatorEntity && owner?.attributes?.length > 0) {
                for (const ownerInstObj of owner.attributes) {
                  if (ownerInstObj?.id === ownerInstanceURN && ownerInstObj?.value && ownerValues.includes(ownerInstObj.value)) {
                    return job;
                  }
                }
              }
            }
          }
        }) as BullJob[];
        filteredResult.push(...filteredResp);
      }
      return filteredResult;
    } else {
      // no custom filters exist, return complete result set
      return result;
    }
  }

  async deleteRedisKey(key: string): Promise<any> {
    try {
      await this.repeatJobIdRedisClient.del(key);
      this.logger?.debug('Redis Key deleted successfully used for mapping repeatable jobID', { key });
    } catch (err: any) {
      this.logger?.error('Error deleting redis key', { key }, decomposeError(err));
    }
  }

  async getRedisValue(key: string): Promise<any> {
    let redisValue;
    try {
      if (key) {
        redisValue = await this.repeatJobIdRedisClient.get(key);
      }
      if (redisValue) {
        return JSON.parse(redisValue);
      } else {
        return;
      }
    } catch (err: any) {
      if (err.message?.startsWith('Unexpected token') || err.message?.startsWith('Unexpected number') || err.message?.startsWith('Unexpected non-whitespace character')) {
        return redisValue;
      } else {
        this.logger?.error('Error reading redis key', { key }, decomposeError(err));
      }
    }
  }


  /**
   * Retrieve jobs.
   * @param {any} call RPC call argument
   * @param {any} ctx RPC context
   */
  async read(request: JobReadRequest, ctx?: any): Promise<DeepPartial<JobListResponse>> {
    const jobListResponse: JobListResponse = { items: [], operation_status: { code: 0, message: '' }, total_count: 0 };
    const subject = request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      ctx ??= {};
      ctx.subject = subject;
      ctx.resources = [];
      acsResponse = await checkAccessRequest(ctx, [{ resource: 'job' }], AuthZAction.READ,
        Operation.whatIsAllowed) as PolicySetRQResponse;
    } catch (err: any) {
      return this.catchOperationStatus(err, 'Error requesting access-control-srv for read operation');
    }

    if (acsResponse.decision !== Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    let result: Array<BullJob>;
    if (_.isEmpty(request) || _.isEmpty(request.filter)
      && (!request.filter || !request.filter.job_ids
        || _.isEmpty(request.filter.job_ids))
      && (!request.filter || !request.filter.type ||
        _.isEmpty(request.filter.type))) {
      result = await this._getJobList();
      const custom_arguments = acsResponse.custom_query_args?.[0];
      result = this.filterByOwnerShip(custom_arguments, result);
    } else {
      result = new Array<BullJob>();
      const jobIDs = Array.isArray(request?.filter?.job_ids) ? request.filter.job_ids : request.filter.job_ids ? [request.filter.job_ids] : [];
      const typeFilterName = request.filter.type;

      // Search in all the queues and retrieve jobs after JobID
      // and add them to the jobIDsCopy list.
      // If the job is not found in any of the queues, continue looking
      // Finally compare the two lists and add an error to status for which
      // job could not be found in any of the queues.
      if (jobIDs?.length > 0) {
        // jobIDsCopy should contain the jobIDs duplicate values
        // after the for loop ends
        const jobIDsCopy: string[] = [];
        for (let jobID of jobIDs ?? []) {
          const jobIdData = await this.getRedisValue(jobID as string);
          // future jobs scheduled with `when` will have same repeatId as external SCS jobID
          if (jobIdData?.repeatId && (jobIdData.repeatId != jobID)) {
            const repeatId = jobIdData.repeatId;
            if (jobIdData?.options?.repeat?.cron && jobIdData?.options?.repeat?.every) {
              jobListResponse.items.push({
                status: {
                  id: jobID.toString(),
                  code: 400,
                  message: 'Both .cron and .every options are defined for this repeatable job'
                }
              });
              continue;
            }
            const nextMillis = this.getNextMillis(Date.now(), jobIdData.options.repeat);
            this.logger?.debug('Repeatable job identifier', { id: jobID, repeatId: `repeat:${repeatId}:${nextMillis}` });
            // map the repeatKey with nextmilis for bull repeatable jobID
            jobID = `repeat:${repeatId}:${nextMillis}`;
          }
          for (const queue of this.queuesList) {
            await new Promise((resolve, reject) => {
              // getJob returns job or null
              queue.getJob(jobID).then(job => {
                if (job?.opts?.repeat?.pattern) {
                  (job.opts.repeat as any).cron = job.opts.repeat.pattern;
                  delete job.opts.repeat.pattern;
                }
                resolve(job);
                if (!_.isEmpty(job)) {
                  result.push(job);
                  if ((job as any)?.opts?.repeat?.jobId) {
                    jobIDsCopy.push((job as any).opts.repeat.jobId);
                  } else {
                    jobIDsCopy.push(jobID);
                  }
                }
              }).catch(err => {
                jobListResponse.items.push({
                  status: this.catchStatus(jobID.toString(), err, `Error reading job ${jobID}`)
                });
              });
            });
          }
        }
        if (!_.isEqual(jobIDs.sort(), jobIDsCopy.sort())) {
          const jobIDsDiff = _.difference(jobIDs, jobIDsCopy);
          for (const jobId of jobIDsDiff) {
            jobListResponse.items.push({
              status: {
                id: jobId.toString(),
                code: 404,
                message: `Job ID ${jobId} not found in any of the queues`
              }
            });
          }
        }
      } else {
        try {
          let jobsList: any[] = [];
          for (const queue of this.queuesList) {
            const getJobsResult = await queue.getJobs(['active', 'delayed', 'repeat']);
            getJobsResult.forEach((job) => {
              if (job?.opts?.repeat?.pattern) {
                (job.opts.repeat as any).cron = job.opts.repeat.pattern;
                delete job.opts.repeat.pattern;
              }
            });
            jobsList = jobsList.concat(getJobsResult);
          }
          result = jobsList;
        } catch (err: any) {
          return this.catchOperationStatus(err, 'Error reading jobs');
        }
      }

      if (typeFilterName) {
        result = result.filter(job => job?.name === typeFilterName);
      }
      const custom_arguments = acsResponse.custom_query_args?.[0]?.custom_arguments;
      result = this.filterByOwnerShip(custom_arguments, result);
    }

    result = result.filter(valid => !!valid);

    if (!_.isEmpty(request) && !_.isEmpty(request.sort)
      && _.includes(['ASCENDING', 'DESCENDING'], request.sort)) {
      let sort: boolean | "desc" | "asc";
      switch (request.sort) {
        case JobReadRequest_SortOrder.DESCENDING:
          sort = 'desc';
          break;
        case JobReadRequest_SortOrder.ASCENDING:
          sort = 'asc';
          break;
        default:
          this.logger?.error(`Unknown sort option ${request.sort}`);
      }
      result = _.orderBy(result, ['id'], [sort]);
    }

    for (const job of result) {
      const jobId = job.id as string;
      if (jobId.startsWith('repeat:')) {
        const repeatKey = jobId.split(':')[1];
        // it could be possible the redis repeat key is deleted on index 8 and old completed
        // jobs exist in data_store if delete on complete was not set to true for repeatable jobs
        const jobRedisId = await this.getRedisValue(repeatKey);
        if (jobRedisId) {
          job.id = jobRedisId;
        }
      }
    }

    for (const job of result) {
      const when = job?.opts?.delay ? new Date(job?.opts?.delay).toString() : '';
      jobListResponse.items.push({
        payload: {
          id: job.id as string,
          type: job.name,
          queue_name: job.queueName,
          data: _filterJobData(job.data, true, this.logger),
          options: _filterJobOptions(job.opts) as any,
          when
        },
        status: {
          id: job.id.toString(),
          code: 200,
          message: 'success'
        }
      });
    }
    jobListResponse.total_count = jobListResponse?.items?.length;
    jobListResponse.operation_status = {
      code: 200,
      message: 'success'
    };
    return jobListResponse;
  }

  async _getJobList(): Promise<BullJob[]> {
    let jobsList: any[] = [];
    for (const queue of this.queuesList) {
      const getJobsResult = await queue.getJobs(['active', 'delayed', 'repeat']);
      getJobsResult.forEach((job) => {
        if (job?.opts?.repeat?.pattern) {
          (job.opts.repeat as any).cron = job.opts.repeat.pattern;
          delete job.opts.repeat.pattern;
        }
      });
      jobsList = jobsList.concat(getJobsResult);
    }
    return jobsList;
  }

  // delete a job by its job instance after processing 'jobDone' / 'jobFailed'
  async _deleteJobInstance(jobId: string, queue: Queue): Promise<void> {
    return this._removeBullJob(jobId, queue);
  }

  /**
   * Delete Job from queue.
   */
  async delete(request: DeleteRequest, ctx: any): Promise<DeleteResponse> {
    const deleteResponse: DeleteResponse = { status: [], operation_status: { code: 0, message: '' } };
    if (_.isEmpty(request)) {
      return {
        operation_status: {
          code: 400,
          message: 'No arguments provided for delete operation'
        }
      };
    }

    try {
      const subject = request?.subject;
      const jobIDs = request?.ids;
      let resources = new Array<DeepPartial<CtxResource>>();
      let action;
      if (jobIDs) {
        action = AuthZAction.DELETE;
        if (_.isArray(jobIDs)) {
          for (const id of jobIDs) {
            resources.push({ id });
          }
        } else {
          resources = [{ id: jobIDs }];
        }
        await this.createMetadata(resources, action, subject);
      }
      if (request.collection) {
        action = AuthZAction.DROP;
        resources = [{ collection: request.collection }];
      }
      let acsResponse: DecisionResponse;
      try {
        if (!ctx) { ctx = {}; };
        ctx.subject = subject;
        ctx.resources = resources;
        acsResponse = await checkAccessRequest(
          ctx, [{ resource: 'job', id: jobIDs as string[] }],
          action,
          Operation.isAllowed
        );
      } catch (err: any) {
        return this.catchOperationStatus(err, 'Error requesting access-control-srv for delete operation');
      }
      if (acsResponse.decision != Response_Decision.PERMIT) {
        return {
          status: [],
          operation_status: acsResponse.operation_status
        };
      }
      const dispatch = [];
      this.logger?.info('Received delete request');
      if ('collection' in request && request.collection) {
        this.logger?.info('Deleting all jobs');
        for (const queue of this.queuesList || []) {
          const jobs = await queue.getJobs(['paused', 'repeat', 'wait', 'active', 'delayed',
            'prioritized', 'waiting', 'waiting-children', 'completed', 'failed']);
          for (const job of jobs || []) {
            if (!job) {
              continue;
            }
            let deleted;
            if (job?.repeatJobKey) {
              deleted = await queue.removeJobScheduler(job?.repeatJobKey);
            } else {
              const id = job.key ? job.key : job.id;
              deleted = await queue.removeJobScheduler(id);
            }
            this.logger?.info('Job deleted with key', { key: job.key, name: job.name });
            const jobIdentifier = job.id ? job.id : job.name;
            if (this.resourceEventsEnabled) {
              dispatch.push(this.jobEvents.emit('jobsDeleted', { id: jobIdentifier }));
            }
            deleteResponse.status.push({
              id: jobIdentifier,
              code: 200,
              message: 'success'
            });
          }
        }
        // FLUSH redis DB index 8 used for mapping of repeat jobIds (since req is for dropping job collection)
        const delResp = await this.repeatJobIdRedisClient.flushDb();
        if (delResp) {
          this.logger?.info('Mapped keys for repeatable jobs deleted successfully');
        } else {
          this.logger?.info('Could not delete repeatable job keys');
        }
        await this.clear();
      } else if ('ids' in request) {
        this.logger?.info('Deleting jobs by their IDs', { id: request.ids });

        for (const queue of this.queuesList) {
          for (const jobDataKey of request.ids) {
            let callback: Promise<boolean>;
            const jobIdData = await this.getRedisValue(jobDataKey as string);
            // future jobs scheduled with `when` will have same repeatId as external SCS jobID
            if (jobIdData?.repeatId && (jobIdData.repeatId != jobDataKey)) {
              const jobs = await queue.getJobSchedulers();
              for (const job of jobs) {
                if (job?.key === jobIdData.repeatId) {
                  this.logger?.info('Removing Repeatable job by key', { key: job.key, name: job.name, id: jobDataKey });
                  callback = queue.removeJobScheduler(job.key);
                  deleteResponse.status.push({
                    id: jobDataKey,
                    code: 200,
                    message: 'success'
                  });
                  await this.deleteRedisKey(jobDataKey as string);
                  await this.deleteRedisKey(jobIdData.repeatId);
                  break;
                }
              }
            } else {
              callback = queue.getJob(jobDataKey).then(async (jobData) => {
                if (jobData) {
                  try {
                    await this._removeBullJob(jobData.id, queue);
                    await this.deleteRedisKey(jobData.id);
                    deleteResponse.status.push({
                      id: jobData.id.toString(),
                      code: 200,
                      message: 'success'
                    });
                  } catch (err: any) {
                    deleteResponse.status.push(
                      this.catchStatus(jobData.id.toString(), err)
                    );
                    return false;
                  }
                  return true;
                }
                return false;
              });
            }

            // since no CB is returned for removeRepeatableByKey by bull
            if (!callback) {
              if (this.resourceEventsEnabled) {
                dispatch.push(this.jobEvents.emit(
                  'jobsDeleted', { id: jobDataKey })
                );
              }
            } else {
              callback.then(() => {
                if (this.resourceEventsEnabled) {
                  dispatch.push(this.jobEvents.emit(
                    'jobsDeleted', { id: jobDataKey })
                  );
                }
              }).catch(err => {
                deleteResponse.status.push(
                  this.catchStatus(jobDataKey.toString(), err, 'Error deleting job')
                );
              });
            }
          }
        }
      }

      await Promise.all(dispatch);
      deleteResponse.operation_status = { code: 200, message: 'success' };
    } catch (err: any) {
      this.catchOperationStatus(err);
    }
    return deleteResponse;
  }

  /**
   * Clean up queues - removes complted and failed jobs from queue
   * @param {any} job clean up job
   */
  async cleanupJobs(ttlAfterFinished: number, maxJobsToCleanLimit: number) {
    for (const queue of this.queuesList) {
      try {
        await queue.clean(ttlAfterFinished, maxJobsToCleanLimit, COMPLETED_JOB_STATE);
        await queue.clean(ttlAfterFinished, maxJobsToCleanLimit, FAILED_JOB_STATE);
      } catch (err) {
        this.logger?.error('Error cleaning up jobs', decomposeError(err));
      }
    }
    this.logger?.info('Jobs cleaned up successfully');
    const lastExecutedInterval = { lastExecutedInterval: (new Date()).toString() };
    await this.repeatJobIdRedisClient.set(QUEUE_CLEANUP, JSON.stringify(lastExecutedInterval));
  }

  async setupCleanInterval(cleanInterval: number, ttlAfterFinished: number, maxJobsToCleanLimit: number) {
    if (!ttlAfterFinished) {
      ttlAfterFinished = DEFAULT_CLEANUP_COMPLETED_JOBS;
    }
    const intervalData = await this.getRedisValue(QUEUE_CLEANUP);
    let timeInMs, delta;
    const now = new Date().getTime();
    if (intervalData?.lastExecutedInterval && typeof (intervalData.lastExecutedInterval) === 'string') {
      timeInMs = new Date(intervalData.lastExecutedInterval).getTime();
      this.logger?.debug('Previous execution interval', intervalData);
      delta = now - timeInMs;
      this.logger?.debug('Clean interval and previous difference', { cleanInterval, difference: delta });
    }

    if (delta && (delta < cleanInterval)) {
      // use setTimeout and then create interval on setTimeout
      this.logger?.info('Restoring previous execution interval with set timeout', { time: cleanInterval - delta });
      setTimeout(async () => {
        await this.cleanupJobs(ttlAfterFinished, maxJobsToCleanLimit);
        setInterval(this.cleanupJobs.bind(this), cleanInterval, ttlAfterFinished, maxJobsToCleanLimit);
      }, cleanInterval - delta);
    } else {
      setInterval(this.cleanupJobs.bind(this), cleanInterval, ttlAfterFinished, maxJobsToCleanLimit);
      this.logger?.info('Clean up job interval set successfully');
    }
  }

  /**
   * Reschedules a job - deletes it and recreates it with a new generated ID.
   */
  async update(request: JobList, ctx: any): Promise<DeepPartial<JobListResponse>> {
    const subject = request.subject;
    // update meta data for owners information
    await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = request?.items?.map((job) => {
        const { data, ...resource } = job;
        return resource;
      });
      acsResponse = await checkAccessRequest(ctx,
        [{ resource: 'job', id: request.items.map(item => item.id) }],
        AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err: any) {
      return this.catchOperationStatus('Error requesting access-control-srv for update operation', err);
    }
    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (_.isNil(request) || _.isNil(request.items)) {
      return {
        operation_status: {
          code: 400,
          message: 'Missing items in update request'
        }
      };
    }

    const mappedJobs = request?.items?.reduce((obj, job) => {
      obj[job.id] = job;
      return obj;
    }, {} as Record<string, Job>);

    const jobData = await this.read(JobReadRequest.fromPartial(
      {
        filter: {
          job_ids: Object.keys(mappedJobs)
        },
        subject
      }
    ), ctx);

    await this.delete(DeleteRequest.fromPartial({
      ids: Object.keys(mappedJobs),
      subject
    }), {});

    const result = new Array<Job>();

    jobData?.items?.forEach(async (job) => {
      const mappedJob = mappedJobs[job?.payload?.id];
      const endJob = {
        id: mappedJob.id,
        type: mappedJob.type,
        queue_name: job?.payload?.queue_name,
        options: {
          ...job.payload.options,
          ...(mappedJob.options ? mappedJob.options : {})
        },
        data: mappedJob.data || job.payload.data,
        when: mappedJob.when,
      };

      if (endJob.when && endJob.options) {
        delete (endJob.options as any).delay;
      }

      result.push(endJob);
    });

    return this.create(JobList.fromPartial({
      items: result,
      subject
    }), ctx);
  }

  /**
   * Upserts a job - creates a new job if it does not exist or update the
   * existing one if it already exists.
   */
  async upsert(request: JobList, ctx: any): Promise<DeepPartial<JobListResponse>> {
    const subject = request.subject;
    await this.createMetadata(request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = request?.items?.map((job) => {
        const { data, ...resource } = job;
        return resource;
      });
      acsResponse = await checkAccessRequest(ctx,
        [{ resource: 'job', id: request.items.map(item => item.id) }],
        AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err: any) {
      return this.catchOperationStatus(err, 'Error requesting access-control-srv for upsert operation')
    }

    if (acsResponse.decision != Response_Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (_.isNil(request) || _.isNil(request.items)) {
      return { operation_status: { code: 400, message: 'Missing items in upsert request' } };
    }

    const result = new Array<JobResponse>;
    for (const eachJob of request.items) {
      let jobExists = false;
      const origJobId = _.cloneDeep(eachJob.id);
      for (const queue of this.queuesList) {
        const jobIdData = await this.getRedisValue(eachJob.id as string);
        // future jobs scheduled with `when` will have same repeatId as external SCS jobID
        if (jobIdData?.repeatId && (jobIdData.repeatId != origJobId)) {
          const repeatId = jobIdData.repeatId;
          if (jobIdData?.options?.repeat?.cron && jobIdData?.options?.repeat?.every) {
            result.push({
              status: {
                id: origJobId,
                code: 400,
                message: 'Both .cron and .every options are defined for this repeatable job'
              }
            });
            continue;
          }
          const nextMillis = this.getNextMillis(Date.now(), jobIdData.options.repeat);
          this.logger?.debug('Repeatable job identifier', { id: eachJob.id, repeatId: `repeat:${repeatId}:${nextMillis}` });
          // map the repeatKey with nextmilis for bull repeatable jobID
          eachJob.id = `repeat:${repeatId}:${nextMillis}`;
        }
        const jobInst = await queue.getJob(eachJob.id);
        if (jobInst) {
          // existing job update it with the given job identifier
          if (eachJob.id.startsWith('repeat:')) {
            eachJob.id = origJobId;
          }
          result.push(
            ...((await this.update(JobList.fromPartial({ items: [eachJob], subject }), ctx))?.items ?? [])
          );
          jobExists = true;
          break;
        }
      }
      if (!jobExists) {
        // new job create it
        result.push(
          ...((await this.create(JobList.fromPartial({ items: [eachJob], subject }), ctx))?.items ?? [])
        );
      }
    }

    return {
      items: result,
      total_count: result.length,
      operation_status: {
        code: 200,
        message: 'success'
      }
    };
  }

  /**
   * Clear all job data.
   */
  async clear(): Promise<any> {
    let allJobs: any[] = [];
    for (const queue of this.queuesList) {
      allJobs = allJobs.concat(await queue.getJobs(['paused', 'repeat', 'wait', 'active', 'delayed',
        'prioritized', 'waiting', 'waiting-children', 'completed', 'failed']));
    }
    return Promise.all(allJobs.map(async (job) => job?.remove())).catch(err => {
      this.logger?.error(`Error clearing jobs`, decomposeError(err));
      throw err;
    });
  }

  async _removeBullJob(jobInstID: string, queue: Queue): Promise<void> {
    return queue.getJob(jobInstID).then(job => {
      if (job) {
        return job.remove();
      }
    }).then(() => {
      this.logger?.info(`Job#${jobInstID} removed`);
    }).catch(err => {
      this.logger?.error(`Error removing job ${jobInstID}`, decomposeError(err));
      throw err;
    });
  }

  /**
   * reads meta data from DB and updates owners information in resource if action is UPDATE / DELETE
   * @param resources list of resources
   * @param action resource action
   * @param subject subject name
   */
  async createMetadata(resources: any, action: string, subject: Subject): Promise<any> {
    const orgOwnerAttributes: Attribute[] = [];
    if (resources && !_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    if (subject?.scope && (action === AuthZAction.CREATE || action === AuthZAction.MODIFY)) {
      // add subject scope as default owners
      orgOwnerAttributes.push(
        {
          id: urns?.ownerIndicatoryEntity,
          value: urns?.organization,
          attributes: [{
            id: urns?.ownerInstance,
            value: subject?.scope,
            attributes: []
          }]
        });
    }

    if (resources?.length > 0) {
      for (const resource of resources) {
        if (!resource.data) {
          resource.data = { meta: {} };
        } else if (!resource.data.meta) {
          resource.data.meta = {};
        }
        if (resource?.id && (action === AuthZAction.MODIFY || action === AuthZAction.DELETE)) {
          let result;
          try {
            result = await this.read(JobReadRequest.fromPartial({
              filter: {
                job_ids: [resource.id]
              },
              subject
            }), {});
          } catch (error: any) {
            if (error.message?.startsWith('Error! Jobs not found in any of the queues') && action != AuthZAction.DELETE) {
              this.logger?.debug('New job should be created', { jobId: resource.id });
              result = { items: [] };
            } else {
              this.logger?.error(`Error reading job with resource ID ${resource.id}`, decomposeError(error));
            }
          }
          // update owners info
          if (result?.items?.length === 1 && result?.items[0]?.payload) {
            const item = result.items[0].payload;
            resource.data.meta.owners = item.data.meta.owners;
            // adding meta to resource root (needed by access-contorl-srv for owners information check)
            // meta is inside data of resource since the data is persisted in redis using bull
            resource.meta = { owners: item.data.meta.owners };
          } else if ((!result || !result.items || !result.items[0] || !result.items[0].payload) && action === AuthZAction.MODIFY) {
            // job does not exist - create new job (ex: Upsert with action modify)
            const ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            // add user as default owners
            ownerAttributes.push(
              {
                id: urns?.ownerIndicatoryEntity,
                value: urns?.user,
                attributes: [{
                  id: urns?.ownerInstance,
                  value: subject?.id,
                  attributes: []
                }]
              });
            resource.data.meta.owners = ownerAttributes;
            resource.meta = { owners: ownerAttributes };
          }
        } else if ((action === AuthZAction.CREATE || !resource.id) && !resource.data.meta.owners) {
          const ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          if (!resource.id) {
            resource.id = uuid.v4().replace(/-/g, '');
          }
          // add user as default owners
          if (resource.id) {
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user,
                attributes: [{
                  id: urns.ownerInstance,
                  value: subject?.id,
                  attributes: []
                }]
              });
          }
          resource.data.meta.owners = ownerAttributes;
          resource.meta = { owners: ownerAttributes };
        } else if (action === AuthZAction.CREATE && resource?.data?.meta?.owners) {
          resource.meta = { owners: resource.data.meta.owners };
        }
      }
    }
    return resources;
  }
}
