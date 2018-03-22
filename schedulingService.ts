import * as _ from 'lodash';
import * as kue from 'kue-scheduler';
import { schedule } from './kue_extensions';
import { errors } from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { RedisClient, createClient } from 'redis';

const JOB_DONE_EVENT = 'jobDone';
const JOB_FAILED_EVENT = 'jobFailed';

function decodeValue(value: any): Object {
  let ret = {};
  if (value.number_value) {
    ret = value.number_value;
  }
  else if (value.string_value) {
    ret = value.string_value;
  }
  else if (value.bool_value) {
    ret = value.bool_value;
  }
  else if (value.list_value) {
    ret = _.map(value.list_value.values, (v) => {
      return toObject(v, true);
    });
  }
  else if (value.struct_value) {
    ret = toObject(value.struct_value);
  }
  return ret;
}

function toObject(struct: any, fromArray: any = false): Object {
  let obj = {};
  if (!fromArray) {
    _.forEach(struct.fields, (value, key) => {
      obj[key] = decodeValue(value);
    });
  }
  else {
    obj = decodeValue(struct);
  }
  return obj;
}

kue.prototype.schedule = schedule;

export enum Priority {
  NORMAL = 0,
  LOW = 10,
  MEDIUM = -5,
  HIGH = -10,
  CRITICAL = -15,
}

export enum Backoffs {
  FIXED = 'FIXED',
  EXPONENTIAL = 'EXPONENTIAL'
}

export interface JobService {
  create(call: any, context: any): Promise<any>;
  update(call: any, context: any): any;
  read(call: any, context: any): any;
  delete(call: any, context: any): any;
}

enum SortOrder {
  ASCENDING = 'ASCENDING',
  DESCENDING = 'DESCENDING',
  UNSORTED = 'UNSORTED'
}

const KUE_PREFIX = 'scheduling-srv';

/**
 * A job scheduling service.
 */
export class SchedulingService implements JobService {
  jobEvents: kafkaClient.Topic;
  jobResourceEvents: kafkaClient.Topic;
  logger: any;
  queue: any;
  jobCbs: any;
  redisClient: RedisClient;
  resourceEventsEnabled: boolean;
  redisSubscriber: RedisClient;
  constructor(jobEvents: kafkaClient.Topic, jobResourceEvents: kafkaClient.Topic, redisConfig: any, logger: any, redisCache: any) {
    this.jobEvents = jobEvents;
    this.jobResourceEvents = jobResourceEvents;
    this.resourceEventsEnabled = true;

    this.logger = logger;

    const options = {
      prefix: KUE_PREFIX,
      redis: redisConfig,
      restore: true
    };
    this.queue = kue.createQueue(options);

    const that = this;
    redisCache.store.getClient((err, redisConn) => {
      this.redisClient = redisConn.client;
      this.redisSubscriber = createClient(redisConfig); // second client connection
    });
  }

  /**
   * Start handling the job queue, job scheduling and
   * managing job events.
   */
  async start(): Promise<any> {
    const logger = this.logger;
    const jobCbs = {};
    this.jobCbs = jobCbs;
    const that = this;
    const events = [JOB_DONE_EVENT, JOB_FAILED_EVENT];
    for (let eventName of events) {
      await this.jobEvents.on(eventName, async function listener(msg: any, ctx: any,
        config: any, eventName: string): Promise<any> {
        let job = msg;

        if (eventName === JOB_FAILED_EVENT) {
          logger.error(`job@${job.type}#${job.id} failed with error`, job.error,
            that._filterQueuedJob(job));
        } else if (eventName === JOB_DONE_EVENT) {
          logger.verbose(`job#${job.id} done`, that._filterQueuedJob(job));
        }

        const cb = jobCbs[job.id];
        if (_.isNil(cb)) {
          logger.error(`job ${job.id} does not exist`);
        } else {
          delete jobCbs[job.id];
          cb();
          if (job.schedule_type != 'RECCUR') {
            await that._deleteJobInstance(job.id);
            logger.verbose(`job#${job.id} succesfully deleted`, that._filterQueuedJob(job));
          }
        }
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
  }

  process(jobType: string, jobUUID: string, parallel: number): any {
    const jobCbs: any = this.jobCbs;
    const that = this;
    this.queue.process(jobType, parallel, (job, done) => {
      const jobInstID = job.id;
      jobCbs[jobInstID] = done;

      job.schedule = job.data.schedule;
      job = that._filterQueuedJob(job);

      // subscribing deletion events on Redis
      // when deleting job by unique ID, job gets deleted
      that.redisSubscriber.subscribe(`jobDeleted-${jobUUID}`);
      that.redisSubscriber.on('message', (channel, message) => {
        kue.Job.get(jobInstID, (err, kueJob) => {
          if (err) {
            that.logger.error(err);
            throw err;
          }

          kueJob.remove((err) => {
            if (err) {
              that.logger.error(err);
              throw err;
            }
            that.redisSubscriber.unsubscribe(`jobDeleted-${jobUUID}`);
          });
        });
      });

      that.jobEvents.emit('queuedJob', {
        id: jobInstID,
        type: job.type,
        data: job.data,
        schedule_type: job.schedule,
      }).catch((error) => {
        delete jobCbs[job.id];
        that.logger.error(`Error while processing job ${job.id} in queue: ${error}`);
        done(error);
      }).then(() => done());

      that.logger.verbose(`job@${job.type}#${job.id} queued`, that._filterQueuedJob(job));
    });
  }

  _validateJob(job: any): any {
    if (_.isNil(job.type)) {
      this._handleError(new errors.InvalidArgument('Job type not specified.'));
    }
    if (job.when) {
      // If the jobSchedule time has already lapsed then do not schedule the job
      const jobScheduleTime = new Date(job.when).getTime();
      const currentTime = new Date().getTime();
      if (jobScheduleTime < currentTime) {
        this._handleError(new errors.InvalidArgument('Cannot schedule a job for an elapsed time'));
      }
    }

    if (_.isEmpty(job.data)) {
      this._handleError(new errors.InvalidArgument('No job data specified.'));
    }

    if (_.isEmpty(job.data.creator)) {
      this._handleError(new errors.InvalidArgument('No job creator specified.'));
    }

    job.data = this._filterJobData(job.data);
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
  async create(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in create request.'));
    }

    const that = this;
    const jobs = _.map(call.request.items, that._validateJob.bind(this));

    // scheduling jobs
    for (let i = 0; i < jobs.length; i += 1) {
      let job = jobs[i];
      job.data.timezone = job.data.timezone || 'Europe/London'; // fallback to GMT

      const data = _.cloneDeep(job.data);

      let qjob = this.queue.createJob(job.type, data);
      let uniqueName = new Date().toISOString().replace(/:/g, "_"); // unique name is a timestamp
      uniqueName = _.snakeCase(uniqueName);
      qjob = qjob.unique(uniqueName);

      let priority;
      if (_.isString(job.priority) && !_.isNil(Priority[job.priority])) {
        priority = Priority[job.priority];
      } else if (_.isNumber(job.priority) && !_.isNil(Priority[job.priority])) {
        priority = job.priority;
      }

      if (priority) {
        qjob = qjob.priority(priority);
      }
      if (job.attempts !== 0) {
        qjob = qjob.attempts(job.attempts);
      }
      if (!_.isNil(job.backoff) && !_.isNil(Backoffs[job.backoff])) {
        qjob = qjob.backoff(job.backoff);
      }
      if (_.size(job.interval) > 0) {
        this.queue.every(job.interval, qjob);
      } else if (_.size(job.when) > 0) {
        this.queue.schedule(job.when, qjob);
      } else {
        this.queue.now(qjob);
      }

      const parallel: number = job.parallel || 1;
      const jobDataKey = this.queue._getJobDataKey(uniqueName);
      this.process(job.type, jobDataKey, parallel);
      this.logger.verbose(`job@${job.type} created with ${parallel} concurrent runs`, job);

      this.redisClient.sadd(job.data.creator, jobDataKey, (error, reply) => {
        if (error) {
          that._handleError(`Error occurred when mapping job to creator: ${error}`);
        }
      });

      job.id = jobDataKey;
      await this.jobResourceEvents.emit('jobsCreated', job);
    }

    return {
      items: jobs,
      total_count: jobs.length
    };
  }

  /**
   * Retrieve jobs.
   * @param {any} call RPC call argument
   * @param {any} context RPC context
   */
  async read(call: any, context?: any): Promise<any> {
    let jobs = [];
    if (_.isEmpty(call) || _.isEmpty(call.request) || _.isEmpty(call.request.filter)) {
      jobs = await this._getJobList();
    } else if (call.request.filter) {
      const that = this;
      const uuid = call.request.filter.id;
      const creator = call.request.filter.creator;

      let jobIDs = [];
      if (uuid) {
        jobIDs.push(uuid);
      } else if (creator) {
        this.redisClient.smembers(creator, (error, reply) => {
          if (error) {
            that._handleError(`Error retrieving creator jobs: ${error}`);
          }

          jobIDs = reply;
        });
      }

      for (let jobID of jobIDs) {
        this.queue._readJobData(jobID, (error, job) => {
          if (error) {
            that._handleError(`Error reading job ${jobID}: ${error}`);
          }

          jobs.push(that._filterQueuedJob(job));
        });
      }
    }

    if (!_.isEmpty(call.request.sort)
      && _.includes(['ASCENDING', 'DESCENDING'], call.request.sort)) {
      let sort;
      switch (call.request.sort) {
        case 'DESCENDING':
          sort = 'desc';
          break;
        case 'ASCENDING':
          sort = 'asc';
          break;
        default:
          this.logger.error(`Unknown sort option ${sort}`);
      }
      jobs = _.orderBy(jobs, ['id'], [sort]);
    }

    return {
      items: jobs,
      total_count: jobs.length
    };
  }

  _getJobList(): any {
    const that = this;
    return new Promise((resolve, reject) => {
      that.queue._getAllJobData((error, jobs) => {
        if (error) {
          that._handleError(error);
          reject(error);
        }
        resolve(_.map(jobs, that._filterKueJob.bind(this)));
      });
    });
  }

  // delete a job by its job instance after processing 'jobDone' / 'jobFailed'
  async _deleteJobInstance(jobInstID: number): Promise<void> {
    const that = this;

    kue.Job.get(jobInstID, (err, job) => {
      if (err) {
        that._handleError(err);
      }

      let uniqueKey = _.snakeCase(job.data.unique);
      const dataKey = that.queue._getJobDataKey(uniqueKey);

      that.delete({
        request: {
          ids: [dataKey]
        }
      }).catch((err) => {
        if (err) {
          that._handleError(err);
        }
      }).then();
    });
  }

  /**
   * Delete Job from queue.
   * @param {string} resource id
   */
  async delete(call: any, context?: any): Promise<any> {
    if (_.isEmpty(call) || ((!call.request.collection && _.isEmpty(call.request.ids)))) {
      this._handleError(new errors.InvalidArgument('No arguments provided for delete operation'));
    }

    const collection = call.request.collection || false;
    const ids = call.request.ids || [];

    this.logger.info('Received delete request');
    const that = this;
    const dispatch = [];
    if (collection) {
      this.logger.verbose('Deleting all jobs');
      kue.Job.range(0, -1, 'desc', (err, jobs) => {
        _.forEach(jobs, (job) => {
          const id = job.data.dataKey;
          dispatch.push(that.jobResourceEvents.emit('jobsDeleted', { id }));
        });
      });
      await this.clear();
    } else {
      this.logger.verbose('Deleting jobs by their IDs', call.request.ids);
      _.forEach(ids, (jobDataKey) => {
        let removed = false;

        that.queue.remove({
          jobDataKey
        }, (err, reply) => {
          if (err) {
            that._handleError(err);
          }
          removed = reply.removedJobData == 1;
          if (removed) {
            that.redisClient.publish(`jobDeleted-${jobDataKey}`, '', (err, reply) => {
              if (err) {
                that._handleError(err);
              }
            });
          }

          dispatch.push(that.jobResourceEvents.emit('jobsDeleted', { id: jobDataKey }));
        });
      });
    }

    await dispatch;
    return {};
  }

  /**
   * Reschedules a job - deletes it and recreates it with a new generated ID.
   * @param call
   * @param context
   */
  async update(call: any, context?: any): Promise<any> {
    if (_.isNil(call) || _.isNil(call.request) || _.isNil(call.request.items)) {
      this._handleError(new errors.InvalidArgument('Missing items in update request.'));
    }

    const jobIDs = _.map(call.request.items, (job) => { return job.id; });
    await this.delete({
      request: {
        ids: jobIDs
      }
    });
    const updated = await this.create({
      request: {
        items: call.request.items
      }
    });

    return updated;
  }

  /**
   * Clear all job data.
   */
  async clear(): Promise<any> {
    const that = this;
    return new Promise((resolve, reject) => {
      this.queue.clear((error, response) => {
        if (error) {
          that._handleError(error);
          reject(error);
        }
        resolve(response);
      });
    });
  }

  _filterQueuedJob(job: any): Object {
    job = _.pick(job, [
      'id', 'type', 'data', 'schedule'
    ]);

    if (job.data) {
      job.data = this._filterJobData(job.data);
      if (job.data.payload && job.data.payload.value) {
        job.data.payload.value = Buffer.from(job.data.payload.value);
      }
    }

    return job;
  }

  _filterKafkaJob(job: any): Object {
    job = _.pick(job, [
      'id', 'type', 'data', 'backoff', 'priority', 'attempts',
      'parallel', 'interval', 'when', 'now'
    ]);

    if (job.data && job.data.payload && job.data.payload.value) {
      job.data.payload.value = JSON.parse(job.data.payload.value);
      job.data.payload = marshallProtobufAny(job.data.payload.value);
    }
    return job;
  }

  _filterKueJob(job: any): Object {
    job.id = this.queue._getJobDataKey(job.data.unique);
    job.data = this._filterJobData(job.data);
    if (job.data.payload && job.data.payload) {
      job.data.payload.value = Buffer.from(job.data.payload.value);
    }

    if (job.priority) {
      job.priority = Priority[Priority[job.priority]];
    }

    if (job.attempts && job.attempts.max) {
      job.attempts = job.attempts.max;
    }

    if (job.state && job.state == 'delayed') {
      job.when = new Date(job.created_at + job.delay).toISOString();
    } else if (job.reccurInterval) {
      job.interval = job.reccurInterval;
    }
    // note: 'backoff; and 'parallel' are not currently provided
    return _.pick(job, [
      'id', 'type', 'data', 'priority', 'attempts',
      'backoff', 'interval', 'when'
    ]);
  }

  _filterJobData(data: any): Object {
    return _.pick(data, [
      'creator', 'payload', 'timezone'
    ]);
  }
}


/**
 * Marshall any job payload to google.protobuf.Any
 * @param payload
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
 * @param data
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

