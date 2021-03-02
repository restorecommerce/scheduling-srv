import * as _ from 'lodash';
import { errors } from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { Subject, AuthZAction, ACSAuthZ, Decision, PermissionDenied, updateConfig } from '@restorecommerce/acs-client';
import { RedisClient } from 'redis';
import { Job, JobId, JobOptions } from 'bull';
import * as Queue from 'bull';
import {
  CreateCall, DeleteCall, Data, NewJob, JobService, ReadCall, UpdateCall,
  SortOrder, GRPCResult, Priority, Backoffs, JobType, JobFailedType, JobDoneType,
  FilterOpts, KafkaOpts
} from './types';
import { parseExpression } from 'cron-parser';
import * as uuid from 'uuid';
import { AccessResponse, checkAccessRequest, ReadPolicyResponse } from './utilts';

const JOB_DONE_EVENT = 'jobDone';
const JOB_FAILED_EVENT = 'jobFailed';

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

  jobCbs: any;
  redisClient: RedisClient;
  resourceEventsEnabled: boolean;
  canceledJobs: Set<string>;
  bullOptions: any;
  cfg: any;
  authZ: ACSAuthZ;
  authZCheck: boolean;


  constructor(jobEvents: kafkaClient.Topic,
    redisConfig: any, logger: any, redisClient: any,
    bullOptions: any, cfg: any, authZ: ACSAuthZ) {
    this.jobEvents = jobEvents;
    this.resourceEventsEnabled = true;
    this.bullOptions = bullOptions;
    this.logger = logger;
    this.queuesList = [];
    this.queuesConfigList = [];
    this.redisClient = redisClient;
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
    this.jobCbs = {};
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

        const jobData = await queue.getJob(job.id).catch(error => {
          that._handleError(error);
        });

        let deleted = false;

        const cb = that.jobCbs[job.id];
        if (_.isNil(cb)) {
          logger.error(`job ${job.id} does not exist`);
        } else {
          delete that.jobCbs[job.id];
          cb();
          const ret = await that._deleteJobInstance(job.id, queue);
          logger.info(`job#${job.id} successfully deleted`, that._filterQueuedJob<JobType>(job));
          deleted = true;
        }

        if (jobData && job.delete_scheduled) {
          await queue.removeRepeatable(jobData.name, jobData.opts.repeat);
          deleted = true;
        }

        if (deleted && that.resourceEventsEnabled) {
          await that.jobEvents.emit('jobsDeleted', { id: job.id });
        }
        await queue.clean(0);
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

      queue.process(processName, concurrency, async (job, done) => {
        this.jobCbs[job.id] = done;

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
                this.redisClient.set(filteredJob.name, lastRunTime);
                filteredJob.data.payload.value = Buffer.from(JSON.stringify(jobTimeObj));
              } else {
                this.redisClient.set(filteredJob.name, lastRunTime);
                filteredJob.data.payload = { value: bufObj };
              }
            } else {
              this.redisClient.set(filteredJob.name, lastRunTime);
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
          delete this.jobCbs[filteredJob.id];
          that.logger.error(`Error while processing job ${filteredJob.id} in queue: ${error}`);
          done(error);
        }).then(() => done());

        that.logger.verbose(`job@${filteredJob.name}#${filteredJob.id} queued`, filteredJob);
      });
    }

    // If the scheduling service goes down and if there were
    // recurring jobs which have missed schedules then
    // we will need to reschedule it for those missing intervals.
    this._rescheduleMissedJobs();
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
        await queue.getJobs(this.bullOptions['allJobTypes']).then(jobs => {
          result = result.concat(jobs);
        }).catch(error => {
          thiz._handleError(`Error reading jobs: ${error}`);
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
            }));
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
      this._handleError(new errors.InvalidArgument('Job type not specified.'));
    }

    if (!job.options) {
      job.options = {};
    }

    if (job.when) {
      if (job.options.delay) {
        this._handleError(new errors.InvalidArgument(
          'Job can either be delayed or dated (when), not both.'
        ));
      }

      // If the jobSchedule time has already lapsed then do not schedule the job
      const jobScheduleTime = new Date(job.when).getTime();
      const currentTime = new Date().getTime();
      if (jobScheduleTime < currentTime) {
        this._handleError(new errors.InvalidArgument(
          'Cannot schedule a job for an elapsed time'
        ));
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
      this._handleError(new errors.InvalidArgument('No job data specified.'));
    }

    job.data = this._filterJobData(job.data, false);

    return job;
  }

  _handleError(err: any): void {
    this.logger.error(err);
    if (_.isString(err)) {
      throw new Error(err);
    } else {
      throw err;
    }
  }

  /**
   * get next job execution time in mili seconds
   * @param millis
   * @param opts
   */
  getNextMillis(millis, opts) {
    if (opts.cron && opts.every) {
      throw new Error(
        'Both .cron and .every options are defined for this repeatable job'
      );
    }

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

  /**
   * Bull generates the repeatKey for repeatable jobs based on jobID, namd and
   * cron settings - so below api to generate the same repeat key and store in redis
   * DB index and map it before making request to bull
   * @param name - job name
   * @param repeat - job repeate options
   * @param jobId - job id
   */
  storeRepeatKey(name, options, jobId) {
    const repeat = options.repeat;
    const endDate = repeat.endDate
      ? new Date(repeat.endDate).getTime() + ':'
      : ':';
    const tz = repeat.tz ? repeat.tz + ':' : ':';
    const suffix = repeat.cron ? tz + repeat.cron : String(repeat.every);
    const repeatKey = name + ':' + jobId + endDate + suffix;
    const jobIdData = { repeatKey, options };
    this.redisClient.set(jobId, JSON.stringify(jobIdData));
    return repeatKey;
  }

  private idGen(): string {
    return uuid.v4().replace(/-/g, '');
  }

  /**
   * Create and queue jobs.
   * @param {any} call RPC call argument
   * @param {any} context RPC context
   */
  async create(call: CreateCall, context?: any): Promise<GRPCResult> {
    let subject = call.request.subject;
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in create request.'));
    }

    await this.createMetadata(call.request.items, AuthZAction.CREATE, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(
        subject, call.request.items, AuthZAction.CREATE, 'job', this
      );
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    const jobs = call.request.items.map(x => this._validateJob(x));
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
        // check if jobID already exists, if so throw error
        const existingJobId = await this.getRedisValue(job.id);
        if (existingJobId) {
          throw new errors.AlreadyExists(`Job with ID already exists`);
        }
        if (!job.options) {
          job.options = { jobId: job.id };
        } else {
          job.options.jobId = job.id;
        }
        if (job?.options?.repeat) {
          (job as any).options.repeat.jobId = job.id;
          this.storeRepeatKey(job.type, job.options, job.id);
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

    return jobList;
  }

  private filterByOwnerShip(readRequest, result) {
    // applying filter based on custom arguments (filterByOwnerShip)
    let customArgs = (readRequest as any).custom_arguments;
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
            if (idVal.id === ownerInstanceURN) {
              ownerInst = idVal.value;
            }
          }
          if (match && ownerInst && ownerValues.includes(ownerInst)) {
            return job;
          }
        }
      });
    }
    return result;
  }

  async getRedisValue(key: string): Promise<any> {
    const redisValue = await new Promise<string>((resolve, reject) => {
      this.redisClient.get(key, (err, response) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.parse(response));
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
   * @param {any} context RPC context
   */
  async read(call: ReadCall, context?: any): Promise<GRPCResult> {
    const readRequest = _.cloneDeep(call.request);
    let subject = call.request.subject;
    let acsResponse: ReadPolicyResponse;
    try {
      acsResponse = await checkAccessRequest(subject, readRequest, AuthZAction.READ,
        'job', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    let result: Job[] = [];
    if (_.isEmpty(call) || _.isEmpty(call.request) || _.isEmpty(call.request.filter)
      && (!call.request.filter || !call.request.filter.job_ids
        || _.isEmpty(call.request.filter.job_ids))
      && (!call.request.filter || !call.request.filter.type ||
        _.isEmpty(call.request.filter.type))) {
      result = await this._getJobList();
      result = this.filterByOwnerShip(readRequest, result);
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
      // Finally compare the two lists and throw an error for which
      // job could not be found in any of the queues.
      if (jobIDs.length > 0) {
        // jobIDsCopy should contain the jobIDs duplicate values
        // after the for loop ends
        let jobIDsCopy: JobId[] = [];
        for (let jobID of jobIDs) {
          // TODO: 1) check if jobID does exist in redis DB
          // 2) If so get all repeatable jobs and check for matching repeatKey for the givenJOB ID
          // 3) Update the repeate jobID internally for searching in the Queue
          const jobIdData = await this.getRedisValue(jobID as string);
          if (jobIdData && jobIdData.repeateKey) {
            const repeatKey = jobIdData.repeatKey;
            const nextMillis = this.getNextMillis(Date.now(), jobIdData.options);
            // map the repeatKey with nextmilis for bull repeatable jobID
            jobID = `repeat:${repeatKey}:${nextMillis}`;
            console.log('JOB ID found is...', jobID);
          }
          for (let queue of this.queuesList) {
            await new Promise((resolve, reject) => {
              // getJob returns job or null
              queue.getJob(jobID).then(job => {
                resolve(job);
                if (!_.isEmpty(job)) {
                  result.push(job);
                  jobIDsCopy.push(jobID);
                }
              }).catch(err => {
                that._handleError(`Error reading jobs ${jobID}: ${err}`);
              });
            });
          }
        }
        if (!_.isEqual(jobIDs.sort(), jobIDsCopy.sort())) {
          const jobIDsDiff = _.difference(jobIDs, jobIDsCopy);
          that._handleError(`Error! Jobs not found in any of the queues, jobIDs: ${jobIDsDiff}`);
        }
      } else {
        try {
          let jobsList: any[] = [];
          for (let queue of this.queuesList) {
            const getJobsResult = await queue.getJobs(this.bullOptions['allJobTypes']);
            jobsList = jobsList.concat(getJobsResult);
          }
          result = jobsList;
        } catch (err) {
          that._handleError(`Error reading jobs: ${err}`);
        }
      }

      if (typeFilterName) {
        result = result.filter(job => job.name === typeFilterName);
      }
      result = this.filterByOwnerShip(readRequest, result);
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
    return {
      items: result.map(job => ({
        id: job.id,
        type: job.name,
        data: this._filterJobData(job.data, true),
        options: this._filterJobOptions(job.opts)
      })),
      total_count: result.length
    };
  }

  async _getJobList(): Promise<Job[]> {
    let jobsList: any[] = [];
    for (let queue of this.queuesList) {
      const getJobsResult = await queue.getJobs(this.bullOptions['allJobTypes']);
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
  async delete(call: DeleteCall, context?: any): Promise<object> {
    if (_.isEmpty(call)) {
      this._handleError(new errors.InvalidArgument(
        'No arguments provided for delete operation'
      ));
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
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, action,
        'job', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
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
        }
      });
    } else if ('ids' in call.request) {
      this.logger.verbose('Deleting jobs by their IDs', call.request.ids);

      for (let queue of this.queuesList) {
        call.request.ids.forEach(async (jobDataKey) => {
          let callback: Promise<void>;

          const jobIdData = await this.getRedisValue(jobDataKey as string);
          if (jobIdData && jobIdData.repeateKey) {
            const repeatKey = jobIdData.repeatKey;
            const nextMillis = this.getNextMillis(Date.now(), jobIdData.options);
            // map the repeatKey with nextmilis for bull repeatable jobID
            jobDataKey = `repeat:${repeatKey}:${nextMillis}`;
            console.log('JOB ID found is...', jobDataKey);
          }
          const jobInst = await queue.getJob(jobDataKey);
          if (jobInst?.opts?.repeat) {
            callback = queue.removeRepeatableByKey(jobDataKey as string);
          } else {
            callback = queue.getJob(jobDataKey).then(async (jobData) => {
              if (jobData) {
                this._removeBullJob(jobData.id, queue);
              }
            });
          }

          callback.then(() => {
            if (this.resourceEventsEnabled) {
              dispatch.push(this.jobEvents.emit(
                'jobsDeleted', { id: jobDataKey })
              );
            }
          }).catch(err => {
            this._handleError(err);
          });
        });
      }
    }

    await Promise.all(dispatch);

    return {};
  }

  /**
   * Reschedules a job - deletes it and recreates it with a new generated ID.
   */
  async update(call: UpdateCall, context?: any): Promise<GRPCResult> {
    let subject = call.request.subject;
    // update meta data for owner information
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(
        subject, call.request.items, AuthZAction.MODIFY, 'job', this
      );
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(
        acsResponse.response.status.message, acsResponse.response.status.code
      );
    }
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in update request.'));
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
    });

    await this.delete({
      request: {
        ids: Object.keys(mappedJobs),
        subject
      }
    });

    const result: NewJob[] = [];

    jobData.items.forEach(job => {
      const mappedJob = mappedJobs[job.id];
      // update job repeate key based on updated job repeat options
      if (job.options?.repeat) {
        this.storeRepeatKey(job.type, job.options, job.id);
      }
      let endJob = {
        type: mappedJob.type || job.name,
        options: {
          ...job.opts,
          ...(mappedJob.options ? mappedJob.options : {})
        },
        data: mappedJob.data || job.data,
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
    });
  }

  /**
   * Upserts a job - creates a new job if it does not exist or update the
   * existing one if it already exists.
   */
  async upsert(call: any, context?: any): Promise<GRPCResult> {
    let subject = call.request.subject;
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request.items, AuthZAction.MODIFY,
        'job', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }

    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in upsert request.'));
    }

    let result = [];

    for (let eachJob of call.request.items) {
      let jobExists = false;
      for (let queue of this.queuesList) {
        const jobIdData = await this.getRedisValue(eachJob.id as string);
        if (jobIdData && jobIdData.repeateKey) {
          const repeatKey = jobIdData.repeatKey;
          const nextMillis = this.getNextMillis(Date.now(), jobIdData.options);
          // map the repeatKey with nextmilis for bull repeatable jobID
          eachJob.id = `repeat:${repeatKey}:${nextMillis}`;
          console.log('JOB ID found is...', eachJob.id);
        }
        const jobInst = await queue.getJob(eachJob.id);
        if (jobInst) {
          // existing job update it
          result = [
            ...result,
            ...(await this.update({ request: { items: eachJob, subject } })).items
          ];
          jobExists = true;
          break;
        }
      }
      if (!jobExists) {
        // new job create it
        result = [
          ...result,
          ...(await this.create({ request: { items: eachJob, subject } })).items
        ];
      }
    }

    return {
      items: result,
      total_count: result.length
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
      this._handleError(err);
      throw err;
    });
  }

  /**
   * retrieves and deletes the stalled (failed and completed) Jobs
   */
  async flushStalledJobs(stalledJobID: string, jobType: string): Promise<void> {
    try {
      let result;
      let jobIdsToDelete = [];
      for (let queue of this.queuesList) {
        await queue.getJobs(['completed', 'failed']).then(jobs => {
          result = jobs;
        }).catch(error => {
          this._handleError(`Error getting stalled jobs: ${error}`);
        });
        for (let job of result) {
          jobIdsToDelete.push(job.id);
        }
      }
      this.logger.debug('Following stalled job instances will be deleted:', { jobIDs: jobIdsToDelete });
      await this.delete({ request: { ids: jobIdsToDelete } }).catch(error => {
        this._handleError(`Error occurred deleting jobs ${jobIdsToDelete} : ${error}`);
      });
      await this.jobEvents.emit('jobDone', {
        id: stalledJobID,
        type: jobType,
        schedule_type: 'RECCUR'
      });
    } catch (err) {
      await this.jobEvents.emit('jobFailed', {
        id: stalledJobID,
        error: err.message,
        type: jobType,
        schedule_type: 'RECCUR'
      });
    }
  }

  _filterQueuedJob<T extends FilterOpts>(job: T): Pick<T, 'id' | 'type' | 'data' | 'opts' | 'name'> {
    (job as any).type = (job as any).name;
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

    return picked;
  }

  async _removeBullJob(jobInstID: JobId, queue: Queue.Queue): Promise<void> {
    return queue.getJob(jobInstID).then(job => {
      if (job) {
        return job.remove();
      }
    }).then(() => {
      this.logger.info(`Immediate job#${jobInstID} removed`);
    }).catch(err => {
      this._handleError(err);
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
          let result = await this.read({
            request: {
              filter: {
                job_ids: resource.id
              },
              subject
            }
          });
          // update owner info
          if (result.items.length === 1) {
            let item = result.items[0];
            resource.data.meta.owner = item.data.meta.owner;
            // adding meta to resource root (needed by access-contorl-srv for owner information check)
            // meta is inside data of resource since the data is persisted in redis using bull
            resource.meta = { owner: item.data.meta.owner };
          } else if (result.items.length === 0 && action === AuthZAction.MODIFY) {
            let ownerAttributes = _.cloneDeep(orgOwnerAttributes);
            // add user as default owner
            ownerAttributes.push(
              {
                id: urns.ownerIndicatoryEntity,
                value: urns.user
              },
              {
                id: urns.ownerInstance,
                value: resource.id
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
                value: resource.id
              });
          }
          resource.data.meta.owner = ownerAttributes;
          resource.meta = { owner: ownerAttributes };
        }
      }
    }
    return resources;
  }
}
