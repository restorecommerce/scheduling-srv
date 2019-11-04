import * as _ from 'lodash';
import { errors } from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { RedisClient } from 'redis';
import {Job, JobId, JobOptions} from 'bull';
import * as Queue from 'bull';
import {
  CreateCall,
  DeleteCall,
  NewJob,
  JobService,
  ReadCall,
  UpdateCall,
  SortOrder,
  GRPCResult, Priority, Backoffs
} from "./types";
import {load, Root} from 'protobufjs';

const JOB_DONE_EVENT = 'jobDone';
const JOB_FAILED_EVENT = 'jobFailed';

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
  jobProtoRoot: Root;

  constructor(jobEvents: kafkaClient.Topic,
    jobResourceEvents: kafkaClient.Topic, redisConfig: any, logger: any,
    redisCache: any, bullOptions: any, cfg: any) {
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
    this.canceledJobs = new Set<string>();

    const root = new Root();
    root.resolvePath = (origin, target) => cfg.get('server:transports:0:protoRoot') + target;
    this.jobProtoRoot = root.loadSync("io/restorecommerce/job.proto");
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
      await this.jobEvents.on(eventName, async function listener(msg: any, ctx: any,
        config: any, eventName: string): Promise<any> {
        let job = msg;

        if (eventName === JOB_FAILED_EVENT) {
          logger.error(`job@${job.type}#${job.id} failed with error #${job.error}`,
            that._filterQueuedJob(job));
        } else if (eventName === JOB_DONE_EVENT) {
          logger.verbose(`job#${job.id} done`, that._filterQueuedJob(job));
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
          if (job.schedule_type != 'RECCUR') {
            await that._deleteJobInstance(job.id);
            logger.verbose(`job#${job.id} successfully deleted`, that._filterQueuedJob(job));
            deleted = true;
          }
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
      logger.verbose(`job@${job.type}#${job.id} scheduled`, that._filterQueuedJob(job));
    });
    this.queue.on('already scheduled', (job) => {
      logger.warn(`job@${job.type}#${job.id} already scheduled`, that._filterQueuedJob(job));
    });
    this.queue.on('scheduler unknown job expiry key', (message) => {
      logger.warn('scheduler unknown job expiry key', message);
    });
    this.queue.on('waiting', (jobId) => {
      logger.verbose(`job#${jobId} scheduled`, jobId);
    });

    this.queue.process('*', async(job, done) => {
      this.jobCbs[job.id] = done;

      const filteredJob = that._filterQueuedJob(job);

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
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in create request.'));
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

      if (job && job.data && job.data.payload && job.data.payload.value) {
        job.data.payload.value = job.data.payload.value.toString();
      }

      result.push(await this.queue.add(job.type, job.data, job.options));

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

  /**
   * Retrieve jobs.
   * @param {any} call RPC call argument
   * @param {any} context RPC context
   */
  async read(call: ReadCall, context?: any): Promise<GRPCResult> {
    let result: Job[] = [];
    if (_.isEmpty(call) || _.isEmpty(call.request) || _.isEmpty(call.request.filter)
      && (!call.request.filter || !call.request.filter.job_ids
        || _.isEmpty(call.request.filter.job_ids))
      && (!call.request.filter || !call.request.filter.type ||
        _.isEmpty(call.request.filter.type))) {
      result = await this._getJobList();
    } else {
      const that = this;
      const jobIDs = call.request.filter.job_ids || [];
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
          callback = this.queue.getJob(jobDataKey).then(async (jobData) => this._removeBullJob(jobData.id));
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
        }
      }
    });

    await this.delete({
      request: {
        ids: Object.keys(mappedJobs)
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
        items: result
      }
    });
  }

  /**
   * Upserts a job - creates a new job if it does not exist or update the
   * existing one if it already exists.
   */
  async upsert(call: any, context?: any): Promise<GRPCResult> {
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
        ...(await this.update({ request: { items: updateJobsList } })).items
      ];
    }

    if (createJobsList.length > 0) {
      result = [
        ...result,
        ...(await this.create({ request: { items: createJobsList } })).items
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

  _filterQueuedJob<T extends any>(job: T): Pick<T, 'id' | 'type' | 'data' | 'opts' | 'name'> {
    job.type = job.name;

    job = _.pick(job, [
      'id', 'type', 'data', 'opts', 'name'
    ]);

    if (job.data) {
      job.data = this._filterJobData(job.data, false);
      if (job.data.payload && job.data.payload.value) {
        job.data.payload.value = Buffer.from(job.data.payload.value);
      }
    }

    return job as any;
  }

  _filterKafkaJob<T extends any>(job: T): Pick<T, 'id' | 'type' | 'data' | 'options' | 'when'> {
    job = _.pick(job, [
      'id', 'type', 'data', 'options', 'when'
    ]);

    if (job.data && job.data.payload && job.data.payload.value) {
      // Re-marshal because protobuf messes up toJSON
      job.data.payload = marshallProtobufAny(unmarshallProtobufAny(job.data.payload));
    }

    return job as any;
  }

  _filterJobData<T extends any>(data: T, encode: boolean): Pick<T, 'meta' | 'payload' | 'timezone'> {
    const picked = _.pick(data, [
      'meta', 'payload', 'timezone'
    ]);

    if (encode) {
      if (picked.payload && picked.payload.value && typeof picked.payload.value === 'string') {
        picked.payload = marshallProtobufAny(unmarshallProtobufAny(picked.payload));
      }
    }

    return picked;
  }

  _filterJobOptions(data: JobOptions): Pick<JobOptions, 'priority' | 'attempts' | 'backoff' | 'repeat'> {
    let picked = _.pick(data, [
      'priority', 'attempts', 'backoff', 'repeat'
    ]);

    if (typeof picked.priority === 'number') {
      picked.priority = Priority[picked.priority];
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
      return job.remove();
    }).then(() => {
      this.logger.info(`Immediate job#${jobInstID} removed`);
    }).catch(err => {
      this._handleError(err);
    });
  }
}


/**
 * Marshall any job payload to google.protobuf.Any
 */
export function marshallProtobufAny(data: any): any {
  const stringified = JSON.stringify(data);
  return {
    type_url: '',
    value: Buffer.from(stringified)
  };
}


/**
 * Unmarshall a job payload.
 */
export function unmarshallProtobufAny(data: any): any {
  let unmarshalled = {};

  if (!_.isEmpty(data)) {
    const payloadValue = data.value;
    const decoded = payloadValue.toString();
    unmarshalled = JSON.parse(decoded);
  }

  return unmarshalled;
}

