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
import { getSubjectFromRedis, AccessResponse, checkAccessRequest, ReadPolicyResponse } from './utilts';

const JOB_DONE_EVENT = 'jobDone';
const JOB_FAILED_EVENT = 'jobFailed';

/**
 * Marshall any job payload to google.protobuf.Any
 */
export const marshallProtobufAny = (data: any): any => {
  const stringified = JSON.stringify(data);
  return {
    type_url: '',
    value: Buffer.from(stringified)
  };
};


/**
 * Unmarshall a job payload.
 */
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
  jobResourceEvents: kafkaClient.Topic;
  logger: any;
  queue: Queue.Queue;
  jobCbs: any;
  redisClient: RedisClient;
  resourceEventsEnabled: boolean;
  canceledJobs: Set<string>;
  bullOptions: any;
  cfg: any;
  redisSubjectClient: RedisClient;
  authZ: ACSAuthZ;
  authZCheck: boolean;


  constructor(jobEvents: kafkaClient.Topic,
    jobResourceEvents: kafkaClient.Topic, redisConfig: any, logger: any,
    redisCache: any, bullOptions: any, cfg: any, redisSubjectCache: any, authZ: ACSAuthZ) {
    this.jobEvents = jobEvents;
    this.jobResourceEvents = jobResourceEvents;
    this.resourceEventsEnabled = true;
    this.bullOptions = bullOptions;

    this.logger = logger;

    const prefix = bullOptions['prefix'] || 'scheduling-srv';

    this.queue = new Queue(prefix, {
      redis: {
        ...redisConfig,
        keyPrefix: prefix
      }
    });

    redisCache.store.getClient((err, redisConn) => {
      // this redis client object is for storing recurrTime to DB index 7
      this.redisClient = redisConn.client;
    });
    redisSubjectCache.store.getClient((err, redisConn) => {
      // this redis client object is for retreiving HR scope data
      this.redisSubjectClient = redisConn.client;
    });
    this.canceledJobs = new Set<string>();
    this.cfg = cfg;
    this.authZ = authZ;
    this.authZCheck = this.cfg.get('authorization:enabled');
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
      await this.jobEvents.on(eventName, async (msg: any, ctx: any,
        config: any, eventName: string): Promise<any> => {
        let job = msg;

        if (eventName === JOB_FAILED_EVENT) {
          logger.error(`job@${job.type}#${job.id} failed with error #${job.error}`,
            that._filterQueuedJob<JobFailedType>(job));
        } else if (eventName === JOB_DONE_EVENT) {
          logger.verbose(`job#${job.id} done`, that._filterQueuedJob<JobDoneType>(job));
        }

        const jobData = await that.queue.getJob(job.id).catch(error => {
          that._handleError(error);
        });

        let deleted = false;

        const cb = that.jobCbs[job.id];
        if (_.isNil(cb)) {
          logger.error(`job ${job.id} does not exist`);
        } else {
          delete that.jobCbs[job.id];
          cb();
          await that._deleteJobInstance(job.id);
          logger.info(`job#${job.id} successfully deleted`, that._filterQueuedJob<JobType>(job));
          deleted = true;
        }

        if (jobData && job.delete_scheduled) {
          await that.queue.removeRepeatable(jobData.name, jobData.opts.repeat);
          deleted = true;
        }

        if (deleted && that.resourceEventsEnabled) {
          await that.jobResourceEvents.emit('jobsDeleted', { id: job.id });
        }

        await that.queue.clean(0);
      });
    }

    this.queue.on('schedule error', (error) => {
      logger.error('kue-scheduler', error);
    });
    this.queue.on('schedule success', (job) => {
      logger.verbose(`job@${job.type}#${job.id} scheduled`, that._filterQueuedJob<JobType>(job));
    });
    this.queue.on('already scheduled', (job) => {
      logger.warn(`job@${job.type}#${job.id} already scheduled`, that._filterQueuedJob<JobType>(job));
    });
    this.queue.on('scheduler unknown job expiry key', (message) => {
      logger.warn('scheduler unknown job expiry key', message);
    });
    this.queue.on('waiting', (jobId) => {
      logger.verbose(`job#${jobId} scheduled`, jobId);
    });

    this.queue.process('*', async (job, done) => {
      this.jobCbs[job.id] = done;

      const filteredJob = that._filterQueuedJob<JobType>(job);
      // For recurrning job add time so if service goes down we can fire jobs
      // for the missed schedules comparing the last run time
      let lastRunTime;
      if (filteredJob.opts && filteredJob.opts.repeat &&
        ((filteredJob.opts.repeat as Queue.EveryRepeatOptions).every ||
          (filteredJob.opts.repeat as Queue.CronRepeatOptions).cron)) {
        if (filteredJob.data) {
          // adding time to payload data for recurring jobs
          const dateTime = new Date();
          const bufObj = Buffer.from(JSON.stringify({ time: dateTime }));
          if (filteredJob.data.payload) {
            if (filteredJob.data.payload.value) {
              let jobBufferObj = JSON.parse(filteredJob.data.payload.value.toString());
              if (!jobBufferObj) {
                jobBufferObj = {};
              }
              const jobTimeObj = Object.assign(jobBufferObj, { time: dateTime });
              lastRunTime = JSON.stringify({ time: dateTime });
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
        schedule_type: filteredJob.opts.timeout === 1 ? 'NOW' : (filteredJob.opts.repeat ? 'RECCUR' : 'ONCE'),
      }).catch((error) => {
        delete this.jobCbs[filteredJob.id];
        that.logger.error(`Error while processing job ${filteredJob.id} in queue: ${error}`);
        done(error);
      }).then(() => done());

      that.logger.verbose(`job@${filteredJob.name}#${filteredJob.id} queued`, filteredJob);
    });
    // if the scheduling service goes down and if there were recurring jobs which have missed
    // schedules then we will need to reschedule it for those missing intervals
    await this._rescheduleMissedJobs();
  }

  /**
   * To reschedule the missed recurring jobs upon service restart
   */
  async  _rescheduleMissedJobs(): Promise<void> {
    // for jobs created via Kafka currently there are no acs checks
    this.disableAC();
    const createDispatch = [];
    let result: any[] = [];
    let thiz = this;
    // get all the jobs
    await this.queue.getJobs(this.bullOptions['allJobTypes']).then(jobs => {
      result = jobs;
    }).catch(error => {
      thiz._handleError(`Error reading jobs: ${error}`);
    });
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
          this.logger.error('Error occured reading the last run time for job type:', { name: job.name, err });
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
          const intervalTime = parseExpression((job.opts.repeat as Queue.CronRepeatOptions).cron, options);
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
        this._handleError(new errors.InvalidArgument('Job can either be delayed or dated (when), not both.'));
      }

      // If the jobSchedule time has already lapsed then do not schedule the job
      const jobScheduleTime = new Date(job.when).getTime();
      const currentTime = new Date().getTime();
      if (jobScheduleTime < currentTime) {
        this._handleError(new errors.InvalidArgument('Cannot schedule a job for an elapsed time'));
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
   * Create and queue jobs.
   * @param {any} call RPC call argument
   * @param {any} context RPC context
   */
  async create(call: CreateCall, context?: any): Promise<GRPCResult> {
    let subject = await getSubjectFromRedis(call, this.redisSubjectClient);
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in create request.'));
    }

    await this.createMetadata(call.request.items, AuthZAction.CREATE, subject);
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, call.request.items, AuthZAction.CREATE,
        'job', this);
    } catch (err) {
      this.logger.error('Error occurred requesting access-control-srv:', err);
      throw err;
    }
    if (acsResponse.decision != Decision.PERMIT) {
      throw new PermissionDenied(acsResponse.response.status.message, acsResponse.response.status.code);
    }

    const jobs = call.request.items.map(x => this._validateJob(x));

    const result: Job[] = [];

    // scheduling jobs
    for (let i = 0; i < jobs.length; i += 1) {
      let job = jobs[i];
      job.data.timezone = job.data.timezone || 'Europe/London'; // fallback to GMT

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

      result.push(await this.queue.add(job.type, job.data, bullOptions));

      this.logger.verbose(`job@${job.type} created`, job);

      if (this.resourceEventsEnabled && (!('timeout' in job.options) || job.options.timeout !== 1)) {
        await this.jobResourceEvents.emit('jobsCreated', job);
      }
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

  /**
   * Retrieve jobs.
   * @param {any} call RPC call argument
   * @param {any} context RPC context
   */
  async read(call: ReadCall, context?: any): Promise<GRPCResult> {
    const readRequest = _.cloneDeep(call.request);
    let subject = await getSubjectFromRedis(call, this.redisSubjectClient);
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

      if (jobIDs.length > 0) {
        for (let jobID of jobIDs) {
          await new Promise((resolve, reject) => {
            this.queue.getJob(jobID).then(job => {
              resolve(job);
              result.push(job);
            }).catch(error => {
              that._handleError(`Error reading job ${jobID}: ${error}`);
            });
          });
        }
      } else {
        await this.queue.getJobs(this.bullOptions['allJobTypes']).then(jobs => {
          result = jobs;
        }).catch(error => {
          that._handleError(`Error reading jobs: ${error}`);
        });
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
    return this.queue.getJobs(this.bullOptions['allJobTypes']);
  }

  // delete a job by its job instance after processing 'jobDone' / 'jobFailed'
  async _deleteJobInstance(jobId: JobId): Promise<void> {
    return this._removeBullJob(jobId);
  }

  /**
   * Delete Job from queue.
   */
  async delete(call: DeleteCall, context?: any): Promise<object> {
    if (_.isEmpty(call)) {
      this._handleError(new errors.InvalidArgument('No arguments provided for delete operation'));
    }
    const subject = await getSubjectFromRedis(call, this.redisSubjectClient);
    const jobIDs = call.request.ids;
    let resources = [];
    if (jobIDs) {
      if (_.isArray(jobIDs)) {
        for (let id of jobIDs) {
          resources.push({ id });
        }
      } else {
        resources = [{ id: jobIDs }];
      }
      await this.createMetadata(resources, AuthZAction.DELETE, subject);
    }
    if (call.request.collection) {
      Object.assign(resources, { collection: call.request.collection });
    }
    let acsResponse: AccessResponse;
    try {
      acsResponse = await checkAccessRequest(subject, resources, AuthZAction.DELETE,
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
            dispatch.push(this.jobResourceEvents.emit('jobsDeleted', { id: job.id }));
          }
        }
      });
    } else if ('ids' in call.request) {
      this.logger.verbose('Deleting jobs by their IDs', call.request.ids);

      call.request.ids.forEach((jobDataKey) => {
        let callback: Promise<void>;

        if (typeof jobDataKey === 'string' && jobDataKey.startsWith('repeat:')) {
          callback = this.queue.removeRepeatableByKey(jobDataKey);
        } else {
          callback = this.queue.getJob(jobDataKey).then(async (jobData) => {
            if (jobData) {
              this._removeBullJob(jobData.id);
            }
          });
        }

        callback.then(() => {
          if (this.resourceEventsEnabled) {
            dispatch.push(this.jobResourceEvents.emit('jobsDeleted', { id: jobDataKey }));
          }
        }).catch(err => {
          this._handleError(err);
        });
      });
    }

    await Promise.all(dispatch);

    return {};
  }

  /**
   * Reschedules a job - deletes it and recreates it with a new generated ID.
   */
  async update(call: UpdateCall, context?: any): Promise<GRPCResult> {
    let subject = await getSubjectFromRedis(call, this.redisSubjectClient);
    // update meta data for owner information
    await this.createMetadata(call.request.items, AuthZAction.MODIFY, subject);
    let acsResponse: AccessResponse;
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
    let subject = await getSubjectFromRedis(call, this.redisSubjectClient);
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
    let createJobsList = [];
    let updateJobsList = [];

    for (let eachJob of call.request.items) {
      if (eachJob.id) {
        // existing job update it
        updateJobsList.push(eachJob);
      } else {
        // new job create it.
        createJobsList.push(eachJob);
      }
    }

    if (updateJobsList.length > 0) {
      result = [
        ...result,
        ...(await this.update({ request: { items: updateJobsList, subject } })).items
      ];
    }

    if (createJobsList.length > 0) {
      result = [
        ...result,
        ...(await this.create({ request: { items: createJobsList, subject } })).items
      ];
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
    return this.queue.getJobs(this.bullOptions['allJobTypes']).then((jobs) => {
      return Promise.all(jobs.map(async (job) => job.remove()));
    }).catch(err => {
      this._handleError(err);
      throw err;
    });
  }

  /**
  * retreives and deletes the stalled (failed and completed) Jobs
  */
  async flushStalledJobs(stalledJobID: string, jobType: string): Promise<void> {
    let result;
    let jobIdsToDelete = [];
    try {
      await this.queue.getJobs(['completed', 'failed']).then(jobs => {
        result = jobs;
      }).catch(error => {
        this._handleError(`Error getting stalled jobs: ${error}`);
      });
      for (let job of result) {
        jobIdsToDelete.push(job.id);
      }
      this.logger.debug('Following stalled job instaces will be deleted:', { jobIDs: jobIdsToDelete });
      await this.delete({ request: { ids: jobIdsToDelete } }).catch(error => {
        this._handleError(`Error occured deleting jobs ${jobIdsToDelete} : ${error}`);
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
        schedule_type: 'RECCUR',
        type: jobType
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

  _removeBullJob(jobInstID: JobId): Promise<void> {
    return this.queue.getJob(jobInstID).then(job => {
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
   * @param reaources list of resources
   * @param entity entity name
   * @param action resource action
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
