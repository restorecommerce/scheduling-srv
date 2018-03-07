'use strict';

import * as _ from 'lodash';
import * as co from 'co';
import * as kue from 'kue-scheduler';
import * as chassis from '@restorecommerce/chassis-srv';
import * as kafkaClient from '@restorecommerce/kafka-client';
import { Worker } from './worker';
import { JobResourceService } from './jobResourceService';
function filterJob(job: any): Object {
  return _.pick(job, [
    'type', 'data', '_max_attempts', '_priority',
    'id', 'zid', 'created_at', 'promote_at',
    '_ttl', '_delay', '_progress', '_attempts',
    '_state', '_error', 'updated_at', 'failed_at',
    'started_at', 'duration', 'workerId',
  ]);
}

const Priority = {
  NORMAL: 0,
  LOW: 10,
  MEDIUM: -5,
  HIGH: -10,
  CRITICAL: -15,
};

/**
 * A job scheduling service.
 */
class SchedulingService {
  events: kafkaClient.Topic;
  logger: any;
  queue: any;
  jobCbs: any;
  cfg: any;
  jobResourceService: JobResourceService;
  constructor(jobEvents: kafkaClient.Topic, redisConfig: any, cfg: any, logger: any, jobResourceService: JobResourceService) {
    this.events = jobEvents;
    this.logger = logger;
    const options = {
      prefix: 'scheduling-srv',
      redis: redisConfig,
    };
    this.queue = kue.createQueue(options);
    this.cfg = cfg;
    this.jobResourceService = jobResourceService;
  }

  /**
   * Start handling the job queue, job scheduling and
   * managing job events.
   */
  async start(jobs: Object[]): Promise<any> {
    const logger: any = this.logger;
    // const cfg = await co(chassis.config.get());
    const jobCbs: Object = {};
    this.jobCbs = jobCbs;
    const that = this;
    await this.events.on('jobDone', async function onDone(msg: any, ctx: any,
      config: any, eventName: string): Promise<any> {
      let job = msg;
      logger.verbose(`job#${job.id} done`, filterJob(job));
      const cb = jobCbs[job.id];
      if (_.isNil(cb)) {
        logger.error(`job ${job.id} does not exist`);
      } else {
        delete jobCbs[job.id];
        cb();
        if (!(job.schedule_type === 'RECCUR')) {
          let jobIDs = [job.job_resource_id];
          let uniqueName = [job.job_unique_name];
          let jobProcID = [job.id];
          await that.jobResourceService.delete({
            request: {
              ids: jobIDs,
              id: jobProcID,
              job_unique_name: uniqueName
            }
          });
          logger.info('Recurring job was successfully deleted from the database', job);
        }
      }
    });
    await this.events.on('jobFailed', async function onFailure(msg: any, ctx: any,
      config: any, eventName: string): Promise<any> {
      let job = msg;
      logger.verbose(`job@${job.type}#${job.id} failed with error`, job.error,
        filterJob(job));
      const cb = jobCbs[job.id];
      if (_.isNil(cb)) {
        logger.error(`job ${job.id} does not exist`);
      } else {
        delete jobCbs[job.id];
        cb();
        if (!(job.schedule_type === 'RECCUR')) {
          let jobIDs = [job.job_resource_id];
          let uniqueName = [job.job_unique_name];
          let jobProcID = [job.id];
          await that.jobResourceService.delete({
            request: {
              ids: jobIDs,
              id: jobProcID,
              job_unique_name: uniqueName
            }
          });
          logger.verbose('Failed job was successfully deleted from the database', job);
        }
      }
    });
    this.queue.on('schedule error', (error) => {
      logger.error('kue-scheduler', error);
    });
    this.queue.on('schedule success', (job) => {
      logger.verbose(`job@${job.type}#${job.id} scheduled`, filterJob(job));
      // jobs.on 'complete', 'failed attempt', 'failed', 'progress'
    });
    this.queue.on('already scheduled', (job) => {
      logger.warn(`job@${job.type}#${job.id} already scheduled`, filterJob(job));
    });
    this.queue.on('scheduler unknown job expiry key', (message) => {
      logger.warn('scheduler unknown job expiry key', message);
    });

    for (let i = 0; i < jobs.length; i += 1) {
      await this.createJob(jobs[i]);
    }
  }

  process(jobName: string, parallel: number, jobResID: string): any {
    const jobEvents: kafkaClient.Topic = this.events;
    const jobCbs: any = this.jobCbs;
    const logger: any = this.logger;
    const that = this;
    this.queue.process(jobName, parallel, (jobInst, done) => {
      jobCbs[jobInst.id] = done;
      logger.verbose(`job@${jobInst.type}#${jobInst.id} queued`, filterJob(jobInst));
      kue.Job.get(jobInst.id, function (err: any, job: any): any {
        const scheduleType = job.data.schedule;
        const jobUniqueName = job.data.unique;
        co(async function emitQueued(): Promise<any> {
          await jobEvents.emit('queuedJob', {
            id: jobInst.id,
            name: jobInst.type,
            data: jobInst.data,
            schedule_type: scheduleType,
            job_resource_id: jobResID,
            job_unique_name: jobUniqueName
          });
        }).catch((error) => {
          delete jobCbs[jobInst.id];
          logger.error('queue processing', error);
          done(error);
        });
        done();
      });
    });
  }

  /**
   * Queue a job.
   * @param {Object} job A job description.
   */
  async createJob(job: any): Promise<any> {
    let data: any;
    if (_.isNil(job.data)) {
      data = { id: job.id };
    } else {
      data = _.cloneDeep(job.data);
    }
    let qjob = this.queue.createJob(job.name, data);
    if (_.size(job.unique) > 0) {
      qjob = qjob.unique(job.unique);
    }
    const p = Priority[job.priority];
    if (p) {
      qjob = qjob.priority(p);
    }
    if (job.attempts !== 0) {
      qjob = qjob.attempts(job.attempts);
    }
    if (!_.isNil(job.backoff)) {
      qjob = qjob.backoff(job.backoff);
    }
    if (_.size(job.interval) > 0) {
      // interval to run a jub every 10 seconds from now '*/10 * * * * *'
      // ex: '0 0 5 * * *' to run every day at 5AM
      this.queue.every(job.interval, qjob);
    } else if (_.size(job.when) > 0) {
      this.queue.schedule(job.when, qjob);
    } else {
      this.queue.now(qjob);
    }

    let parallel: number = job.parallel || 1;
    if (parallel <= 0) {
      parallel = 1;
    }
    this.process(job.name, parallel, job.id);
    this.logger.verbose(`job@${job.name} created with ${parallel} concurrent runs`, job);
  }

  /**
   * Delete Job from queue.
   * @param {string} resource id
   */
  deleteJob(id: string, jobUniqueName: string): any {
    let that = this;
    if (jobUniqueName) {
      this.queue.remove({
        unique: jobUniqueName
      }, function (error: any, response: any): any {
        that.logger.info('Job has been deleted successfully', JSON.stringify(response));
      });
    }
    if (id) {
      kue.Job.get(id, function (err: any, job: any): any {
        that.logger.verbose('Deleted job details are :', JSON.stringify(job));
        if (err) return;
        job.remove(function (err: any): any {
          if (err) throw err;
          that.logger.info('removed completed job', job.id);
        });
      });
    }
  }

  /**
   * Shutdown queue.
   */
  async stop(): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.clear((error, response) => {
        if (error) {
          reject(error);
        }
        resolve(response);
      });
    });
  }
}
export { SchedulingService };
