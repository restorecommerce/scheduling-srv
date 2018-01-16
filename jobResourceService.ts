'use strict';

import * as Emitter from 'co-emitter';


// API_Resource CRUD operations
import { ResourcesAPIBase, ServiceBase } from '@restorecommerce/resource-base-interface';
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
    this.emitter = new Emitter();
  }

  async create(call: any, context: any): Promise<any> {
    await this.emitter.emit('createJobs', call.request.items);
    let jobsImmediate: any = [];
    for (let jobItem of call.request.items) {
      // if job is to be executed 'now' i.e. immediately then do not store the
      // job in the database
      if (jobItem.now) {
        jobsImmediate.push(jobItem);
      }
    }
    call.request.items = call.request.items.filter(item => !jobsImmediate.includes(item));
    const result: any = await super.create(call, context);
    for (let jobInst of result.items) {
      if (jobInst.data && jobInst.data.payload) {
        jobInst.data.payload = _.toArray(jobInst.data.payload);
        for (let i = 0; i < jobInst.data.payload.length; i += 1) {
          // As the job process could add additional attributes to data
          // make a check if job data contains value element
          let byteArray = [];
          if (jobInst.data.payload[i].value && jobInst.data.payload[i].value) {
            // mark data as empty when returning
            jobInst.data.payload[i].value = '';
          }
        }
      }
    }
    return result;
  }

  async read(call: any, context: any): Promise<any> {
    const result: any = await super.read(call, context);
    for (let jobInst of result.items) {
      jobInst.data.payload = _.toArray(jobInst.data.payload);
      for (let i = 0; i < jobInst.data.payload.length; i += 1) {
        // As the job process could add additional attributes to data
        // make a check if job data contains value element
        let byteArray = [];
        if (jobInst.data.payload[i].value && jobInst.data.payload[i].value) {
          // delete data value
          delete jobInst.data.payload[i]['value'];
        }
      }
    }
    // delete result.items.total_count;
    return result;
  }

  async delete(call: any, context?: any): Promise<any> {
    const result: any = await super.delete(call, context);
    const deleteJob = [{
      id: call.request.id,
      job_unique_name: call.request.job_unique_name
    }];
    await this.emitter.emit('deleteJobs', deleteJob);
    return result;
  }

  async update(call: any, context: any): Promise<any> {
    const result: any = await super.update(call, context);
    await this.emitter.emit('modifyJobs', result.items);
    return result;
  }

  async upsert(call: any, context: any): Promise<any> {
    const result: any = await super.upsert(call, context);
    await this.emitter.emit('modifyJobs', result.items);
    return result;
  }
}
