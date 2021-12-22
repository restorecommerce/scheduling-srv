import * as _ from 'lodash';
import { errors } from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { Subject, AuthZAction, ACSAuthZ, Decision, updateConfig, DecisionResponse, Operation, PolicySetRQResponse } from '@restorecommerce/acs-client';
import Redis, { Redis as RedisClient } from 'ioredis';
import { Job, JobId, JobOptions } from 'bull';
import Queue from 'bull';
import {
  CreateCall, DeleteCall, Data, NewJob, JobService, ReadCall, UpdateCall,
  SortOrder, JobListResponse, Priority, Backoffs, JobType, JobFailedType, JobDoneType,
  FilterOpts, KafkaOpts, DeleteResponse
} from './types';
import { parseExpression } from 'cron-parser';
import * as crypto from 'crypto';
import { checkAccessRequest } from './utilts';
import * as uuid from 'uuid';

const JOB_DONE_EVENT = 'jobDone';
const JOB_FAILED_EVENT = 'jobFailed';
const DEFAULT_CLEANUP_COMPLETED_JOBS = 604800000; // 7 days in miliseconds
const COMPLETED_JOB_STATE = 'completed';
const FAILED_JOB_STATE = 'failed';
const QUEUE_CLEANUP = 'queueCleanup';

// Marshall any job payload to google.protobuf.Any
export const marshallProtobufAny = (data: any): any => {
  const stringified = JSON.stringify(data);
  return {
    type_url: '',
    value: Buffer.from(stringified)
  };
};

// Unmarshall a job payload.
export const unmarshallProtobufAny = (data: any): any => {
  let unmarshalled = {};

  if (!_.isEmpty(data)) {
    const payloadValue = data.value;
    const decoded = payloadValue.toString();
    unmarshalled = JSON.parse(decoded);
  }
  return unmarshalled;
};

/**
 * A job scheduling service.
 */
export class SchedulingService implements JobService {

  jobEvents: kafkaClient.Topic;
  logger: any;

  queuesConfigList: any;
  queuesList: Queue.Queue[];
  defaultQueueName: string;

  redisClient: RedisClient;
  resourceEventsEnabled: boolean;
  canceledJobs: Set<string>;
  bullOptions: any;
  cfg: any;
  authZ: ACSAuthZ;
  authZCheck: boolean;
  repeatJobIdRedisClient: RedisClient;


  constructor(jobEvents: kafkaClient.Topic,
    redisConfig: any, logger: any, redisClient: RedisClient,
    bullOptions: any, cfg: any, authZ: ACSAuthZ) {
    this.jobEvents = jobEvents;
    this.resourceEventsEnabled = true;
    this.bullOptions = bullOptions;
    this.logger = logger;
    this.queuesList = [];
    this.queuesConfigList = [];
    this.redisClient = redisClient;

    const repeatJobIdCfg = cfg.get('redis');
    repeatJobIdCfg.db = cfg.get('redis:db-indexes:db-repeatJobId');
    this.repeatJobIdRedisClient = new Redis(repeatJobIdCfg);

    this.canceledJobs = new Set<string>();
    this.cfg = cfg;
    this.authZ = authZ;
    this.authZCheck = this.cfg.get('authorization:enabled');

    // Read Queue Configuration file and find first queue which has "default": true,
    // then save it to defaultQueueName
    const queuesCfg = this.cfg.get('queue');
    if (_.isEmpty(queuesCfg)) {
      this.logger.error('Queue configuration not found!');
      throw new Error('Queue configuration not found!');
    }
    let defaultTrueExists = false;
    for (let queueCfg of queuesCfg) {
      // Find configuration which has default=true
      if (queueCfg.default == true) {
        defaultTrueExists = true;
        this.defaultQueueName = queueCfg.name;
        break;
      }
    }
    if (!defaultTrueExists) {
      this.logger.error('Queue default configuration not found!');
      throw new Error('Queue default configuration not found!');
    }

    // Create Queues
    for (let queueCfg of queuesCfg) {
      let queueOptions: Queue.QueueOptions;
      const prefix = queueCfg.name;
      const rateLimiting = queueCfg.rateLimiting;
      const advancedSettings = queueCfg.advancedSettings;

      // Create Queue Configuration - Add Rate Limiting if enabled
      if (!_.isEmpty(rateLimiting) && rateLimiting.enabled == true) {
        this.logger.info(`Queue: ${queueCfg.name} - Rate limiting is ENABLED.`);
        queueOptions = {
          redis: {
            ...redisConfig,
            keyPrefix: prefix
          },
          limiter: {
            max: rateLimiting.max,
            duration: rateLimiting.duration
          }
        };
      } else {
        queueOptions = {
          redis: {
            ...redisConfig,
            keyPrefix: prefix
          }
        };
      }

      if (!_.isEmpty(advancedSettings)) {
        queueOptions.settings = advancedSettings;
      }
      // Add Queue Objects
      let queue = new Queue(prefix, queueOptions);
      this.queuesList.push(queue);

      // Add Queue Configurations
      let queueCfgObj = {
        name: queueCfg.name,
        concurrency: queueCfg.concurrency,
        default: queueCfg.default,
        runMissedScheduled: queueCfg.runMissedScheduled
      };
      this.queuesConfigList.push(queueCfgObj);
    }
  }

  /**
   * Start handling the job queue, job scheduling and
   * managing job events.
   */
  async start(): Promise<any> {
    const logger = this.logger;
    const that = this;

    const events = [JOB_DONE_EVENT, JOB_FAILED_EVENT];
    for (let eventName of events) {
      // A Scheduling Service Event Listener
      await this.jobEvents.on(eventName, async (msg: any, ctx: any,
        config: any, eventName: string): Promise<any> => {
        let job = msg;
        // Match Job Type to Queue Name, else use Default Queue
        let queue = _.find(this.queuesList, { name: job.type });
        let defaultQueue = _.find(this.queuesList, { name: this.defaultQueueName });
        if (_.isEmpty(queue)) {
          queue = defaultQueue;
        }

        if (eventName === JOB_FAILED_EVENT) {
          logger.error(`job@${job.type}#${job.id} failed with error #${job.error}`,
            that._filterQueuedJob<JobFailedType>(job));
        } else if (eventName === JOB_DONE_EVENT) {
          logger.verbose(`job#${job.id} done`, that._filterQueuedJob<JobDoneType>(job));
        }

        logger.info('Received Job event', { event: eventName });
        logger.info('Job details', job);
        const jobData: any = await queue.getJob(job.id).catch(error => {
          that.logger.error('Error retrieving job ${job.id} from queue', error);
        });

        if (jobData) {
          if (eventName === JOB_DONE_EVENT) {
            try {
              let moveJobResponse = await (jobData as Job).moveToCompleted('succeeded', true, true);
              this.logger.debug('Job moved to completed state response', moveJobResponse);
            } catch (err) {
              this.logger.error('Error moving the job to completed state', { name: jobData.name });
            }
          } else if (eventName === JOB_FAILED_EVENT) {
            try {
              let moveJobResponse = await (jobData as Job).moveToFailed({ message: msg.error }, true);
              this.logger.debug('Job moved to failed state response', moveJobResponse);
            } catch (err) {
              this.logger.error('Error moving the job to failed state', { name: jobData.name });
            }
          }
        } else {
          this.logger.error('Job does not exist to move to completed state', job);
        }

        if (jobData && job.delete_scheduled) {
          await queue.removeRepeatable(jobData.name, jobData.opts.repeat);
        }
      });
    }

    // Initialize Event Listeners for each Queue
    for (let queue of this.queuesList) {
      queue.on('schedule error', (error) => {
        logger.error('kue-scheduler', error);
      });
      queue.on('schedule success', (job) => {
        logger.verbose(`job@${job.type}#${job.id} scheduled`, that._filterQueuedJob<JobType>(job));
      });
      queue.on('already scheduled', (job) => {
        logger.warn(`job@${job.type}#${job.id} already scheduled`, that._filterQueuedJob<JobType>(job));
      });
      queue.on('scheduler unknown job expiry key', (message) => {
        logger.warn('scheduler unknown job expiry key', message);
      });
      queue.on('waiting', (jobId) => {
        logger.verbose(`job#${jobId} scheduled`, jobId);
      });
    }

    // Initialize Job Processing Function for each Queue
    // For the Default Queue the process name is defined as "*"
    // For the other Queues the process name is defined as the name of the Queue
    for (let queueCfg of this.queuesConfigList) {
      let queue = _.find(this.queuesList, { name: queueCfg.name });
      let queueName = queueCfg.name;
      let concurrency = queueCfg.concurrency;

      let processName: string;
      if (queueName == this.defaultQueueName) {
        processName = '*';
      } else {
        processName = queueCfg.name;
      }

      queue.process(processName, concurrency, async (job) => {

        const filteredJob = that._filterQueuedJob<JobType>(job);
        // For recurring job add time so if service goes down we can fire jobs
        // for the missed schedules comparing the last run time
        let lastRunTime;
        if (filteredJob.opts && filteredJob.opts.repeat &&
          ((filteredJob.opts.repeat as Queue.EveryRepeatOptions).every ||
            (filteredJob.opts.repeat as Queue.CronRepeatOptions).cron)) {
          if (filteredJob.data) {
            // adding time to payload data for recurring jobs
            const dateTime = new Date();
            lastRunTime = JSON.stringify({ time: dateTime });
            const bufObj = Buffer.from(JSON.stringify({ time: dateTime }));
            if (filteredJob.data.payload) {
              if (filteredJob.data.payload.value) {
                let jobBufferObj = JSON.parse(filteredJob.data.payload.value.toString());
                if (!jobBufferObj) {
                  jobBufferObj = {};
                }
                const jobTimeObj = Object.assign(jobBufferObj, { time: dateTime });
                // set last run time on DB index 7 with jobType identifier
                await this.redisClient.set(filteredJob.name, lastRunTime);
                filteredJob.data.payload.value = Buffer.from(JSON.stringify(jobTimeObj));
              } else {
                await this.redisClient.set(filteredJob.name, lastRunTime);
                filteredJob.data.payload = { value: bufObj };
              }
            } else {
              await this.redisClient.set(filteredJob.name, lastRunTime);
              filteredJob.data = {
                payload: { value: bufObj }
              };
            }
          }
        }

        await that.jobEvents.emit('queuedJob', {
          id: filteredJob.id,
          type: filteredJob.name,
          data: filteredJob.data,
          schedule_type: filteredJob.opts.repeat ? 'RECCUR' : 'ONCE',
        }).catch((error) => {
          that.logger.error(`Error while processing job ${filteredJob.id} in queue: ${error}`);
        });

        that.logger.verbose(`job@${filteredJob.name}#${filteredJob.id} queued`, filteredJob);
      }).catch(err => {
        this.logger.error('Error scheduling job', err);
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
  async _rescheduleMissedJobs(): Promise<void> {
    // for jobs created via Kafka currently there are no acs checks
    this.disableAC();
    const createDispatch = [];
    let result: any[] = [];
    let thiz = this;

    // Get the jobs
    for (let queueCfg of this.queuesConfigList) {
      // If enabled in the config, or the config is missing,
      // Reschedule the missed jobs, else skip.
      let queue = _.find(this.queuesList, { name: queueCfg.name });
      let runMissedScheduled = queueCfg.runMissedScheduled;
      if (_.isNil(runMissedScheduled) ||
        (!_.isNil(runMissedScheduled) && runMissedScheduled == true)) {
        await queue.getJobs(this.bullOptions['activeAndFutureJobTypes']).then(jobs => {
          result = result.concat(jobs);
        }).catch(error => {
          thiz.logger.error('Error reading jobs to reschedule the missed recurring jobs', error);
        });
      }
    }
    let lastRunTime;
    for (let job of result) {
      // get the last run time for the job, we store the last run time only
      // for recurring jobs
      lastRunTime = await new Promise<string>((resolve, reject) => {
        this.redisClient.get(job.name, (err, response) => {
          if (err) {
            reject(err);
          } else {
            resolve(response);
          }
        });
      }).catch(
        (err) => {
          this.logger.error(
            'Error occurred reading the last run time for job type:',
            { name: job.name, err });
        }
      );
      // we store lastRunTime only for recurring jobs and if it exists check
      // cron interval and schedule immediate jobs for missed intervals
      this.logger.info(`Last run time of ${job.name} Job was:`, lastRunTime);
      if (lastRunTime) {
        // convert redis string value to object and get actual time value
        lastRunTime = JSON.parse(lastRunTime);
        if (job.opts && job.opts.repeat &&
          (job.opts.repeat as Queue.CronRepeatOptions).cron) {
          let options = {
            currentDate: new Date(lastRunTime.time),
            endDate: new Date(),
            iterator: true
          };
          const intervalTime =
            parseExpression((job.opts.repeat as Queue.CronRepeatOptions).cron, options);
          while (intervalTime.hasNext()) {
            let nextInterval: any = intervalTime.next();
            const nextIntervalTime = nextInterval.value.toString();
            // schedule it as one time job for now or immediately
            const data = {
              payload: marshallProtobufAny({
                value: { time: nextIntervalTime }
              })
            };
            const currentTime = new Date();
            const immediateJob = {
              type: job.name,
              data,
              // give a delay of 2 sec between each job
              // to avoid time out of queued jobs
              when: currentTime.setSeconds(currentTime.getSeconds() + 2).toString(),
              options: {}
            };
            createDispatch.push(thiz.create({
              request: {
                items: [immediateJob]
              }
            }, {}));
          }
        }
      }
    }
    this.restoreAC();
    await createDispatch;
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
      if (job.options.delay) {
        throw new errors.InvalidArgument(
          'Job can either be delayed or dated (when), not both.'
        );
      }

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
        job.options.backoff.type = Object.keys(Backoffs)[job.options.backoff.type];
      }
      job.options.backoff.type = job.options.backoff.type.toLowerCase();
    }

    if (job.options.priority && typeof job.options.priority === 'string') {
      job.options.priority = Priority[job.options.priority] as any;
    }

    if (_.isEmpty(job.data)) {
      throw new errors.InvalidArgument('No job data specified.');
    }

    job.data = this._filterJobData(job.data, false);

    return job;
  }

  /**
   * get next job execution time in mili seconds
   * @param millis
   * @param opts
   */
  getNextMillis(millis, opts) {
    if (opts.every) {
      return Math.floor(millis / opts.every) * opts.every + opts.every;
    }

    const currentDate =
      opts.startDate && new Date(opts.startDate) > new Date(millis)
        ? new Date(opts.startDate)
        : new Date(millis);
    const interval = parseExpression(
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
      this.logger.error('Error getting next job execution time');
    }
  }

  private md5(str) {
    return crypto
      .createHash('md5')
      .update(str)
      .digest('hex');
  }

  /**
   * Bull generates the repeatKey for repeatable jobs based on jobID, namd and
   * cron settings - so below api to generate the same repeat key and store in redis
   * DB index and map it before making request to bull
   * @param name - job name
   * @param repeat - job repeate options
   * @param jobId - job id
   */
  async storeRepeatKey(name, options, jobId) {
    const repeat = options.repeat;
    const endDate = repeat.endDate
      ? new Date(repeat.endDate).getTime() + ':'
      : ':';
    const tz = repeat.tz ? repeat.tz + ':' : ':';
    const suffix = repeat.cron ? tz + repeat.cron : String(repeat.every);
    const overrRiddentJobId = repeat.jobId ? repeat.jobId + ':' : ':';
    const md5Key = this.md5(name + ':' + overrRiddentJobId + endDate + suffix);
    const repeatKey = this.md5(name + jobId + ':' + md5Key);
    this.logger.info('Repeat key generated for JobId is', { repeatKey, jobId });
    const jobIdData = { repeatKey, options };
    // map jobID with jobIdData - containing repeatKey and options
    await this.repeatJobIdRedisClient.set(jobId, JSON.stringify(jobIdData));
    // to resolve the jobId based on repeatkey
    await this.repeatJobIdRedisClient.set(repeatKey, jobId);
    return repeatKey;
  }

  private idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  /**
   * Create and queue jobs.
   * @param {any} call RPC call argument
   * @param {any} ctx RPC context
   */
  async create(call: CreateCall, ctx: any): Promise<JobListResponse> {
    let jobListResponse: JobListResponse = { items: [], operation_status: { code: 0, message: '' } };
    let subject = call.request.subject;
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      return {
        operation_status: {
          code: 400,
          message: 'Missing items in create request'
        }
      };
    }

    await this.createMetadata(call.request.items, AuthZAction.CREATE, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = call.request.items;
      acsResponse = await checkAccessRequest(ctx, [{
        resource: 'job',
        id: call.request.items.map(item => item.id)
      }], AuthZAction.CREATE, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    let jobs = [];
    for (let job of call.request.items) {
      try {
        jobs.push(this._validateJob(job));
      } catch (err) {
        this.logger.error('Error validating job', job);
        jobListResponse.items.push({
          status: {
            id: job.id,
            code: 400,
            message: err.message
          }
        });
      }
    }

    let result: Job[] = [];
    // Scheduling jobs
    for (let i = 0; i < jobs.length; i += 1) {
      let job = jobs[i];
      job.data.timezone = job.data.timezone || 'Europe/London'; // fallback to GMT

      // if not jobID is specified generate a UUID
      if (!job.id) {
        job.id = this.idGen();
      }

      // map the id to jobId as needed in JobOpts for bull
      if (job.id) {
        // check if jobID already exists then map it as already exists error
        const existingJobId = await this.getRedisValue(job.id);
        if (existingJobId) {
          // read job to check if data exists
          const jobData = await this.read({
            request: {
              filter: {
                job_ids: [job.id]
              },
              subject
            }
          }, ctx);
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
        if (!job.options) {
          job.options = { jobId: job.id };
        } else {
          job.options.jobId = job.id;
        }
        if (job?.options?.repeat) {
          (job as any).options.repeat.jobId = job.id;
          await this.storeRepeatKey(job.type, job.options, job.id);
        }
      }

      if (!job.data.meta) {
        const now = Date.now();
        const metaObj = {
          created: now,
          modified: now,
          modified_by: '',
          owner: []
        };
        Object.assign(job.data, { meta: metaObj });
      }
      // if only owner is specified in meta
      if (job.data.meta && (!job.data.meta.created || !job.data.meta.modified)) {
        job.data.meta.created = Date.now();
        job.data.meta.modified = Date.now();
      }

      if (job && job.data && job.data.payload && job.data.payload.value) {
        job.data.payload.value = job.data.payload.value.toString();
      }

      const bullOptions = {
        ...job.options
      };

      if (bullOptions.timeout === 1) {
        delete bullOptions['timeout'];
      }

      // Match the Job Type with the Queue Name and add the Job to this Queue.
      // If there is no match, add the Job to the Default Queue
      let queue = _.find(this.queuesList, { name: job.type });
      let defaultQueue = _.find(this.queuesList, { name: this.defaultQueueName });
      if (_.isEmpty(queue)) {
        queue = defaultQueue;
      }
      result.push(await queue.add(job.type, job.data, bullOptions));

      this.logger.verbose(`job@${job.type} created`, job);
    }

    for (let job of result) {
      let jobId = job.id as string;
      if (jobId.startsWith('repeat:')) {
        const repeatKey = jobId.split(':')[1];
        job.id = await this.getRedisValue(repeatKey);
      }
    }

    for (let job of result) {
      jobListResponse.items.push({
        payload: {
          id: job.id,
          type: job.name,
          data: this._filterJobData(job.data, true),
          options: this._filterJobOptions(job.opts)
        },
        status: {
          id: (job.id).toString(),
          code: 200,
          message: 'success'
        }
      });
    }
    const jobList = {
      items: result.map(job => ({
        id: job.id,
        type: job.name,
        data: this._filterJobData(job.data, true),
        options: this._filterJobOptions(job.opts)
      })),
      total_count: result.length
    };

    if (this.resourceEventsEnabled) {
      await this.jobEvents.emit('jobsCreated', jobList);
    }

    jobListResponse.operation_status = { code: 200, message: 'success' };
    return jobListResponse;
  }

  private filterByOwnerShip(customArgsObj, result) {
    // applying filter based on custom arguments (filterByOwnerShip)
    let customArgs = (customArgsObj)?.custom_arguments;
    if (customArgs && customArgs.value) {
      const customArgsFilter = JSON.parse(customArgs.value.toString());
      const ownerIndicatorEntity = customArgsFilter.entity;
      const ownerValues = customArgsFilter.instance;
      const ownerIndictaorEntURN = this.cfg.get('authorization:urns:ownerIndicatoryEntity');
      const ownerInstanceURN = this.cfg.get('authorization:urns:ownerInstance');
      let ownerInst;
      let jobOwner = [];
      result = result.filter(job => {
        if (job && job.data && job.data.meta && job.data.meta.owner) {
          jobOwner = job.data.meta.owner;
          let match = false;
          for (let idVal of jobOwner) {
            if (idVal.id === ownerIndictaorEntURN && idVal.value === ownerIndicatorEntity) {
              match = true;
            }
            if (match && idVal.id === ownerInstanceURN) {
              ownerInst = idVal.value;
              match = false;
            }
          }
          if (ownerInst && ownerValues.includes(ownerInst)) {
            return job;
          }
        }
      });
    }
    return result;
  }

  async deleteRedisKey(key: string): Promise<any> {
    await new Promise<string>((resolve: any, reject) => {
      this.repeatJobIdRedisClient.del(key, (err, response) => {
        if (err) {
          reject(err);
        } else {
          this.logger.debug('Redis Key deleted successfully used for mapping repeatable jobID', { key });
          resolve(response);
        }
      });
    }).catch(
      (err) => {
        this.logger.error(
          'Error occurred deleting redis key',
          { key, msg: err.message });
      }
    );
  }

  async getRedisValue(key: string): Promise<any> {
    const redisValue = await new Promise<string>((resolve, reject) => {
      this.repeatJobIdRedisClient.get(key, (err, response) => {
        if (err) {
          reject(err);
        } else {
          try {
            resolve(JSON.parse(response));
          } catch (err) {
            resolve(response);
          }
        }
      });
    }).catch(
      (err) => {
        this.logger.error(
          'Error occurred reading redis key',
          { key, msg: err.message });
      }
    );
    return redisValue;
  }


  /**
   * Retrieve jobs.
   * @param {any} call RPC call argument
   * @param {any} ctx RPC context
   */
  async read(call: ReadCall, ctx: any): Promise<JobListResponse> {
    let jobListResponse: JobListResponse = { items: [], operation_status: { code: 0, message: '' } };
    const readRequest = _.cloneDeep(call.request);
    let subject = call.request.subject;
    let acsResponse: PolicySetRQResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = [];
      acsResponse = await checkAccessRequest(ctx, [{ resource: 'job' }], AuthZAction.READ,
        Operation.whatIsAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }

    let result: Job[] = [];
    if (_.isEmpty(call) || _.isEmpty(call.request) || _.isEmpty(call.request.filter)
      && (!call.request.filter || !call.request.filter.job_ids
        || _.isEmpty(call.request.filter.job_ids))
      && (!call.request.filter || !call.request.filter.type ||
        _.isEmpty(call.request.filter.type))) {
      result = await this._getJobList();
      let custom_arguments;
      if (acsResponse?.custom_query_args && acsResponse.custom_query_args.length > 0) {
        custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
      }
      result = this.filterByOwnerShip({ custom_arguments }, result);
    } else {
      const that = this;
      let jobIDs = call.request.filter.job_ids || [];
      if (!_.isArray(jobIDs)) {
        jobIDs = [jobIDs];
      }
      const typeFilterName = call.request.filter.type;

      // Search in all the queues and retrieve jobs after JobID
      // and add them to the jobIDsCopy list.
      // If the job is not found in any of the queues, continue looking
      // Finally compare the two lists and add an error to status for which
      // job could not be found in any of the queues.
      if (jobIDs.length > 0) {
        // jobIDsCopy should contain the jobIDs duplicate values
        // after the for loop ends
        let jobIDsCopy: JobId[] = [];
        for (let jobID of jobIDs) {
          const jobIdData = await this.getRedisValue(jobID as string);
          if (jobIdData && jobIdData.repeatKey) {
            const repeatKey = jobIdData.repeatKey;
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
            this.logger.debug('Repeatable job identifier', { id: jobID, repeatId: `repeat:${repeatKey}:${nextMillis}` });
            // map the repeatKey with nextmilis for bull repeatable jobID
            jobID = `repeat:${repeatKey}:${nextMillis}`;
          }
          for (let queue of this.queuesList) {
            await new Promise((resolve, reject) => {
              // getJob returns job or null
              queue.getJob(jobID).then(job => {
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
                that.logger.error(`Error reading job ${jobID}`, err);
                if (err?.code && typeof err.code === 'string') {
                  err.code = 500;
                }
                jobListResponse.items.push({
                  status: {
                    id: jobID.toString(),
                    code: err.code,
                    message: err.message
                  }
                });
              });
            });
          }
        }
        if (!_.isEqual(jobIDs.sort(), jobIDsCopy.sort())) {
          const jobIDsDiff = _.difference(jobIDs, jobIDsCopy);
          for (let jobId of jobIDsDiff) {
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
          for (let queue of this.queuesList) {
            const getJobsResult = await queue.getJobs(this.bullOptions['activeAndFutureJobTypes']);
            jobsList = jobsList.concat(getJobsResult);
          }
          result = jobsList;
        } catch (err) {
          that.logger.error('Error reading jobs', err);
          if (typeof err.code === 'string') {
            err.code = 500;
          }
          return {
            operation_status: {
              code: err.code,
              message: err.message
            }
          };
        }
      }

      if (typeFilterName) {
        result = result.filter(job => job.name === typeFilterName);
      }
      let custom_arguments;
      if (acsResponse?.custom_query_args && acsResponse.custom_query_args.length > 0) {
        custom_arguments = acsResponse.custom_query_args[0].custom_arguments;
      }
      result = this.filterByOwnerShip({ custom_arguments }, result);
    }

    result = result.filter(valid => !!valid);

    if (!_.isEmpty(call.request) && !_.isEmpty(call.request.sort)
      && _.includes(['ASCENDING', 'DESCENDING'], call.request.sort)) {
      let sort;
      switch (call.request.sort) {
        case SortOrder.DESCENDING:
          sort = 'desc';
          break;
        case SortOrder.ASCENDING:
          sort = 'asc';
          break;
        default:
          this.logger.error(`Unknown sort option ${sort}`);
      }
      result = _.orderBy(result, ['id'], [sort]);
    }

    for (let job of result) {
      let jobId = job.id as string;
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

    for (let job of result) {
      jobListResponse.items.push({
        payload: {
          id: job.id,
          type: job.name,
          data: this._filterJobData(job.data, true),
          options: this._filterJobOptions(job.opts)
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

  async _getJobList(): Promise<Job[]> {
    let jobsList: any[] = [];
    for (let queue of this.queuesList) {
      const getJobsResult = await queue.getJobs(this.bullOptions['activeAndFutureJobTypes']);
      jobsList = jobsList.concat(getJobsResult);
    }
    return jobsList;
  }

  // delete a job by its job instance after processing 'jobDone' / 'jobFailed'
  async _deleteJobInstance(jobId: JobId, queue: Queue.Queue): Promise<void> {
    return this._removeBullJob(jobId, queue);
  }

  /**
   * Delete Job from queue.
   */
  async delete(call: DeleteCall, ctx: any): Promise<DeleteResponse> {
    let deleteResponse: DeleteResponse = { status: [], operation_status: { code: 0, message: '' } };
    if (_.isEmpty(call)) {
      return {
        operation_status: {
          code: 400,
          message: 'No arguments provided for delete operation'
        }
      };
    }
    const subject = await call.request.subject;
    const jobIDs = call.request.ids;
    let resources = [];
    let action;
    if (jobIDs) {
      action = AuthZAction.DELETE;
      if (_.isArray(jobIDs)) {
        for (let id of jobIDs) {
          resources.push({ id });
        }
      } else {
        resources = [{ id: jobIDs }];
      }
      await this.createMetadata(resources, action, subject);
    }
    if (call.request.collection) {
      action = AuthZAction.DROP;
      resources = [{ collection: call.request.collection }];
    }
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = resources;
      acsResponse = await checkAccessRequest(ctx, [{ resource: 'job', id: jobIDs as string[] }], action,
        Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    const dispatch = [];
    this.logger.info('Received delete request');
    if ('collection' in call.request && call.request.collection) {
      this.logger.verbose('Deleting all jobs');

      await this._getJobList().then(async (jobs) => {
        for (let job of jobs) {
          await job.remove();
          if (this.resourceEventsEnabled) {
            dispatch.push(this.jobEvents.emit('jobsDeleted', { id: job.id }));
          }
          deleteResponse.status.push({
            id: job.id.toString(),
            code: 200,
            message: 'success'
          });
        }
      });
      // FLUSH redis DB index 8 used for mapping of repeat jobIds
      await new Promise((resolve, reject) => {
        this.repeatJobIdRedisClient.flushdb((delResp) => {
          if (delResp) {
            this.logger.debug('Mapped keys for repeatable jobs deleted successfully');
          } else {
            this.logger.debug('Could not delete map keys', delResp);
          }
          resolve(delResp);
        });
      });
    } else if ('ids' in call.request) {
      this.logger.verbose('Deleting jobs by their IDs', call.request.ids);

      for (let queue of this.queuesList) {
        for (let jobDataKey of call.request.ids) {
          let callback: Promise<void>;
          const jobIdData = await this.getRedisValue(jobDataKey as string);
          if (jobIdData && jobIdData.repeatKey) {
            const jobs = await queue.getRepeatableJobs();
            for (let job of jobs) {
              if (job.id === jobDataKey) {
                this.logger.debug('Removing Repeatable job by key for jobId', { id: job.id });
                callback = queue.removeRepeatableByKey(job.key);
                deleteResponse.status.push({
                  id: job.id,
                  code: 200,
                  message: 'success'
                });
                await this.deleteRedisKey(jobDataKey);
                await this.deleteRedisKey(jobIdData.repeatKey);
                break;
              }
            }
          } else {
            callback = queue.getJob(jobDataKey).then(async (jobData) => {
              if (jobData) {
                try {
                  await this._removeBullJob(jobData.id, queue);
                  deleteResponse.status.push({
                    id: jobData.id.toString(),
                    code: 200,
                    message: 'success'
                  });
                } catch (err) {
                  if (typeof err?.code === 'string') {
                    err.code = 500;
                  }
                  deleteResponse.status.push({
                    id: jobData.id.toString(),
                    code: err.code,
                    message: err.message
                  });
                }
              }
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
              this.logger.error('Error deleting job', { id: jobDataKey });
              if (typeof err?.code === 'number') {
                err.code = 500;
              }
              deleteResponse.status.push({
                id: jobDataKey.toString(),
                code: err.code,
                message: err.message
              });
            });
          }
        }
      }
    }

    await Promise.all(dispatch);
    deleteResponse.operation_status = { code: 200, message: 'success' };
    return deleteResponse;
  }

  /**
   * Clean up queues - removes complted and failed jobs from queue
   * @param {any} job clean up job
   */
  async cleanupJobs(ttlAfterFinished) {
    for (let queue of this.queuesList) {
      try {
        await queue.clean(ttlAfterFinished, COMPLETED_JOB_STATE);
        await queue.clean(ttlAfterFinished, FAILED_JOB_STATE);
      } catch (err) {
        this.logger.error('Error cleaning up jobs', err);
      }
    }
    this.logger.info('Jobs cleaned up successfully');
    let lastExecutedInterval = { lastExecutedInterval: (new Date()).toString() };
    await this.repeatJobIdRedisClient.set(QUEUE_CLEANUP, JSON.stringify(lastExecutedInterval));
  }

  async setupCleanInterval(cleanInterval: number, ttlAfterFinished: number) {
    if (!ttlAfterFinished) {
      ttlAfterFinished = DEFAULT_CLEANUP_COMPLETED_JOBS;
    }
    const intervalData = await this.getRedisValue(QUEUE_CLEANUP);
    let timeInMs, delta;
    const now = new Date().getTime();
    if (intervalData?.lastExecutedInterval && typeof (intervalData.lastExecutedInterval) === 'string') {
      timeInMs = new Date(intervalData.lastExecutedInterval).getTime();
      this.logger.debug('Previous execution interval', intervalData);
      delta = now - timeInMs;
      this.logger.debug('Clean interval and previous difference', { cleanInterval, difference: delta });
    }

    if (delta && (delta < cleanInterval)) {
      // use setTimeout and then create interval on setTimeout
      this.logger.info('Restoring previous execution interval with set timeout', { time: cleanInterval - delta });
      setTimeout(async () => {
        await this.cleanupJobs(ttlAfterFinished);
        setInterval(this.cleanupJobs.bind(this), cleanInterval, ttlAfterFinished);
      }, cleanInterval - delta);
    } else {
      setInterval(this.cleanupJobs.bind(this), cleanInterval, ttlAfterFinished);
      this.logger.info('Clean up job interval set successfully');
    }
  }

  /**
   * Reschedules a job - deletes it and recreates it with a new generated ID.
   */
  async update(call: UpdateCall, ctx: any): Promise<JobListResponse> {
    let subject = call.request.subject;
    // update meta data for owner information
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = call.request.items;
      acsResponse = await checkAccessRequest(ctx,
        [{ resource: 'job', id: call.request.items.map(item => item.id) }],
        AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }
    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      return {
        operation_status: {
          code: 400,
          message: 'Missing items in update request'
        }
      };
    }

    const mappedJobs = call.request.items.reduce((obj, job) => {
      obj[job.id] = job;
      return obj;
    }, {});

    const jobData = await this.read({
      request: {
        filter: {
          job_ids: Object.keys(mappedJobs)
        },
        subject
      }
    }, ctx);

    await this.delete({
      request: {
        ids: Object.keys(mappedJobs),
        subject
      }
    }, {});

    const result: NewJob[] = [];

    jobData.items.forEach(async (job) => {
      const mappedJob = mappedJobs[job?.payload?.id];
      // update job repeate key based on updated job repeat options
      if (job?.payload?.options?.repeat) {
        await this.storeRepeatKey(job?.payload?.type, job?.payload?.options, job?.payload?.id);
      }
      let endJob = {
        id: mappedJob.id,
        type: mappedJob.type || job.payload.name,
        options: {
          ...job.payload.opts,
          ...(mappedJob.options ? mappedJob.options : {})
        },
        data: mappedJob.data || job.payload.data,
        when: mappedJob.when,
      };

      if (endJob.when && endJob.options) {
        delete endJob.options['delay'];
      }

      result.push(endJob);
    });

    return this.create({
      request: {
        items: result,
        subject
      }
    }, ctx);
  }

  /**
   * Upserts a job - creates a new job if it does not exist or update the
   * existing one if it already exists.
   */
  async upsert(call: any, ctx: any): Promise<JobListResponse> {
    let subject = call.request.subject;
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: DecisionResponse;
    try {
      if (!ctx) { ctx = {}; };
      ctx.subject = subject;
      ctx.resources = call.request.items;
      acsResponse = await checkAccessRequest(ctx,
        [{ resource: 'job', id: call.request.items.map(item => item.id) }],
        AuthZAction.MODIFY, Operation.isAllowed);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      return {
        operation_status: {
          code: err.code,
          message: err.message
        }
      };
    }

    if (acsResponse.decision != Decision.PERMIT) {
      return { operation_status: acsResponse.operation_status };
    }
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      return { operation_status: { code: 400, message: 'Missing items in upsert request' } };
    }

    let result = [];

    for (let eachJob of call.request.items) {
      let jobExists = false;
      let origJobId = _.cloneDeep(eachJob.id);
      for (let queue of this.queuesList) {
        const jobIdData = await this.getRedisValue(eachJob.id as string);
        if (jobIdData && jobIdData.repeatKey) {
          const repeatKey = jobIdData.repeatKey;
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
          this.logger.debug('Repeatable job identifier', { id: eachJob.id, repeatId: `repeat:${repeatKey}:${nextMillis}` });
          // map the repeatKey with nextmilis for bull repeatable jobID
          eachJob.id = `repeat:${repeatKey}:${nextMillis}`;
        }
        const jobInst = await queue.getJob(eachJob.id);
        if (jobInst) {
          // existing job update it with the given job identifier
          if (eachJob.id.startsWith('repeat:')) {
            eachJob.id = origJobId;
          }
          result = [
            ...result,
            ...(await this.update({ request: { items: [eachJob], subject } }, ctx)).items
          ];
          jobExists = true;
          break;
        }
      }
      if (!jobExists) {
        // new job create it
        result = [
          ...result,
          ...(await this.create({ request: { items: [eachJob], subject } }, ctx)).items
        ];
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
    for (let queue of this.queuesList) {
      allJobs = allJobs.concat(await queue.getJobs(this.bullOptions['allJobTypes']));
    }
    return Promise.all(allJobs.map(async (job) => job.remove())).catch(err => {
      this.logger.error(`Error clearing jobs`, err);
      throw err;
    });
  }

  _filterQueuedJob<T extends FilterOpts>(job: T): Pick<T, 'id' | 'type' | 'data' | 'opts' | 'name'> {
    if (job && !job.type) {
      (job as any).type = (job as any).name;
    }
    const picked: any = _.pick(job, [
      'id', 'type', 'data', 'opts', 'name'
    ]);

    if (picked.data) {
      picked.data = this._filterJobData(picked.data, false);
      if (picked.data.payload && picked.data.payload.value) {
        picked.data.payload.value = Buffer.from(picked.data.payload.value);
      }
    }

    return picked as any;
  }

  _filterKafkaJob<T extends KafkaOpts>(job: T): Pick<T, 'id' | 'type' | 'data' | 'options' | 'when'> {
    const picked: any = _.pick(job, [
      'id', 'type', 'data', 'options', 'when'
    ]);

    if (picked.data && picked.data.payload && picked.data.payload.value) {
      // Re-marshal because protobuf messes up toJSON
      picked.data.payload = marshallProtobufAny(unmarshallProtobufAny(picked.data.payload));
    }

    return picked as any;
  }

  _filterJobData(data: Data, encode: boolean): Pick<Data, 'meta' | 'payload' | 'timezone' | 'subject_id'> {
    const picked = _.pick(data, [
      'meta', 'payload', 'timezone', 'subject_id'
    ]);

    if (encode) {
      if (picked.payload && picked.payload.value && typeof picked.payload.value === 'string') {
        (picked as any).payload = marshallProtobufAny(unmarshallProtobufAny(picked.payload));
      }
    }

    return picked as any;
  }

  _filterJobOptions(data: JobOptions): Pick<JobOptions, 'priority' | 'attempts' | 'backoff' | 'repeat'> {
    let picked = _.pick(data, [
      'priority', 'attempts', 'backoff', 'repeat'
    ]);

    if (typeof picked.priority === 'number') {
      picked.priority = Priority[picked.priority] as any;
    }

    if (typeof picked.backoff === 'object') {
      if (!picked.backoff.type) {
        picked.backoff.type = 'FIXED';
      } else {
        picked.backoff.type = picked.backoff.type.toUpperCase();
      }
    }
    // remove key if it exists in repeat
    if (picked && picked.repeat && (picked.repeat as any).key) {
      delete (picked.repeat as any).key;
    }

    return picked;
  }

  async _removeBullJob(jobInstID: JobId, queue: Queue.Queue): Promise<void> {
    return queue.getJob(jobInstID).then(job => {
      if (job) {
        return job.remove();
      }
    }).then(() => {
      this.logger.info(`Job#${jobInstID} removed`);
    }).catch(err => {
      this.logger.error(`Error removing job ${jobInstID}`, err);
      throw err;
    });
  }

  /**
   *  disable access control
   */
  disableAC() {
    try {
      this.cfg.set('authorization:enabled', false);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught disabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  /**
   *  enables access control
   */
  enableAC() {
    try {
      this.cfg.set('authorization:enabled', true);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught enabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  /**
   *  restore AC state to previous vale either before enabling or disabling AC
   */
  restoreAC() {
    try {
      this.cfg.set('authorization:enabled', this.authZCheck);
      updateConfig(this.cfg);
    } catch (err) {
      this.logger.error('Error caught enabling authorization:', { err });
      this.cfg.set('authorization:enabled', this.authZCheck);
    }
  }

  /**
   * reads meta data from DB and updates owner information in resource if action is UPDATE / DELETE
   * @param resources list of resources
   * @param action resource action
   * @param subject subject name
   */
  async createMetadata(resources: any, action: string, subject?: Subject): Promise<any> {
    let orgOwnerAttributes = [];
    if (resources && !_.isArray(resources)) {
      resources = [resources];
    }
    const urns = this.cfg.get('authorization:urns');
    if (subject && subject.scope && (action === AuthZAction.CREATE || action === AuthZAction.MODIFY)) {
      // add subject scope as default owner
      orgOwnerAttributes.push(
        {
          id: urns.ownerIndicatoryEntity,
          value: urns.organization
        },
        {
          id: urns.ownerInstance,
          value: subject.scope
        });
    }

    if (resources) {
      for (let resource of resources) {
        if (!resource.data) {
          resource.data = { meta: {} };
        } else if (!resource.data.meta) {
          resource.data.meta = {};
        }
        if (action === AuthZAction.MODIFY || action === AuthZAction.DELETE) {
          let result;
          try {
            result = await this.read({
              request: {
                filter: {
                  job_ids: resource.id
                },
                subject
              }
            }, {});
          } catch (err) {
            if (err.message.startsWith('Error! Jobs not found in any of the queues') && action != AuthZAction.DELETE) {
              this.logger.debug('New job should be created', { jobId: resource.id });
              result = { items: [] };
            } else {
              this.logger.error(`Error reading job with resource ID ${resource.id}`, err);
            }
          }
          // update owner info
          if (result?.items?.length === 1 && result?.items[0]?.payload) {
            let item = result.items[0].payload;
            resource.data.meta.owner = item.data.meta.owner;
            // adding meta to resource root (needed by access-contorl-srv for owner information check)
            // meta is inside data of resource since the data is persisted in redis using bull
            resource.meta = { owner: item.data.meta.owner };
          } else if ((!result || !result.items || !result.items[0] || !result.items[0].payload) && action === AuthZAction.MODIFY) {
            // job does not exist - create new job (ex: Upsert with action modify)
            let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            // add user as default owner
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user
              },
              {
                id: urns.ownerInstance,
                value: subject.id
              });
            resource.data.meta.owner = ownerAttributes;
            resource.meta = { owner: ownerAttributes };
          }
        } else if (action === AuthZAction.CREATE && !resource.data.meta.owner) {
          let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
          // add user as default owner
          if (resource.id) {
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user
              },
              {
                id: urns.ownerInstance,
                value: subject.id
              });
          }
          resource.data.meta.owner = ownerAttributes;
          resource.meta = { owner: ownerAttributes };
        } else if (action === AuthZAction.CREATE && resource?.data?.meta?.owner) {
          resource.meta = { owner: resource.data.meta.owner };
        }
      }
    }
    return resources;
  }
}
