'use strict';
import { EventEmitter } from 'events';

// API_Resource CRUD operations
import { ResourcesAPIBase, ServiceBase } from '@restorecommerce/resource-base-interface';
import { errors } from '@restorecommerce/chassis-srv';
import * as _ from 'lodash';

const COLLECTION_NAME = 'jobs';

export class JobResourceService extends ServiceBase {
  db: any;
  logger: any;
  emitter: any;

  constructor(jobResourceEvents: any, db: any, logger: any) {
    const apiBase: ResourcesAPIBase = new ResourcesAPIBase(db, COLLECTION_NAME);
    super(COLLECTION_NAME, jobResourceEvents, logger, apiBase, true);
    this.db = db;
    this.logger = logger;
    this.emitter = new EventEmitter();
  }

  parseJob(job: any): any {
    // Check if the jobs execution time i.e. job.when is > current time.
    // if so process the job else return.
    if (job.when) {
      // If the jobSchedule time has already lapsed then do not schedule
      // the job - fix for kue-scheduler bug.
      const jobScheduleTime = new Date(job.when).getTime();
      const currentTime = new Date().getTime();
      if (jobScheduleTime < currentTime) {
        throw new errors.InvalidArgument(
          'the time schedule for the job is invalid or has already elapsed');
      }
    }

    if (job.data) {
      job.data = _.pick(job.data, ['payload', 'timezone']);
      if (job.data.payload) {
        job.data.payload = marshallProtobufAny(JSON.parse(job.data.payload.value.toString()));
      }
    }

    return job;
  }

  async create(call: any, context: any): Promise<any> {
    let items = call.request.items.map((jobInst) => {
      return this.parseJob(jobInst);
    });

    await this.emitter.emit('createJobs', call.request.items);

    // if job is to be executed 'now' i.e. immediately then do not store the
    // job in the DB
    // cannot directly reduce the initial list as all the jobs is needed for
    // scheduling the jobs

    items = _.reduce(items, (jobs, job) => {
      if (!job.now) {
        jobs.push(job);
      }
      return jobs;
    }, []);

    call.request.items = items;
    // inserting jobs into DB
    const result: any = await super.create(call, context);
    return result;
  }

  async read(call: any, context: any): Promise<any> {
    const result: any = await super.read(call, context);
    return result;
  }

  async delete(call: any, context?: any): Promise<any> {
    // call.request.ids - is the job resouurce id stored in the DB and deleted below.
    const result: any = await super.delete(call, context);
    const deleteJob = [{
      id: call.request.id,
      job_unique_name: call.request.job_unique_name
    }];
    await this.emitter.emit('deleteJobs', deleteJob);
    return result;
  }

  async update(call: any, context: any): Promise<any> {
    let items = call.request.items.map((jobInst) => {
      return this.parseJob(jobInst);
    });

    await this.emitter.emit('modifyJobs', items);

    items = items.map((job) => {
      if (job.data && job.data.payload) {
        job.data.payload = unmarshallProtobufAny(job.data.payload);
      }
      return job;
    });

    const result: any = await super.update(call, context);
    return result;
  }

  async upsert(call: any, context: any): Promise<any> {
    call.request.items = call.request.items.map((jobInst) => {
      return this.parseJob(jobInst);
    });
    const result: any = await super.upsert(call, context);
    await this.emitter.emit('modifyJobs', result.items);
    return result;
  }
}

export function marshallProtobufAny(data: any): any {
  const stringified = JSON.stringify(data);
  return {
    type_url: '',
    value: Buffer.from(stringified).toString('base64')
  };
}

export function unmarshallProtobufAny(data: any): any {
  let unmarshalled = {};
  if (!_.isEmpty(data)) {
    const payloadValue = data.value;
    const decoded = Buffer.from(payloadValue, 'base64').toString();
    unmarshalled = JSON.parse(decoded);
  }

  return unmarshalled;
}
