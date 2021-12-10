import * as _ from 'lodash';
import * as mocha from 'mocha';
import * as should from 'should';

import { SchedulingService, marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';

import { Topic } from '@restorecommerce/kafka-client';
import { createServiceConfig } from '@restorecommerce/service-config';

import {
  validateJob,
  payloadShouldBeEmpty,
  validateScheduledJob,
  jobPolicySetRQ,
  startGrpcMockServer,
  stopGrpcMockServer,
  permitJobRule,
  validateJobDonePayload
} from './utils';
import { Backoffs, NewJob, Priority } from "../lib/types";
import { Logger } from 'winston';
import { updateConfig } from '@restorecommerce/acs-client';

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */


const JOB_EVENTS_TOPIC = 'io.restorecommerce.jobs';

let mockServer: any;
let logger: Logger;
let cfg;
let subject;
// mainOrg -> orgA -> orgB -> orgC
const acsSubject = {
  id: 'admin_user_id',
  scope: 'orgC',
  role_associations: [
    {
      role: 'admin-r-id',
      attributes: [{
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingInstance',
        value: 'mainOrg'
      }]
    }
  ],
  hierarchical_scopes: [
    {
      id: 'mainOrg',
      role: 'admin-r-id',
      children: [{
        id: 'orgA',
        children: [{
          id: 'orgB',
          children: [{
            id: 'orgC'
          }]
        }]
      }]
    }
  ]
};
const acsEnv = process.env.ACS_ENABLED;
let acsEnabled = false;
let testSuffix = '';
if (acsEnv && acsEnv.toLocaleLowerCase() === 'true') {
  acsEnabled = true;
  testSuffix = 'with ACS Enabled';
} else {
  testSuffix = 'with ACS Disabled';
}

describe(`testing scheduling-srv ${testSuffix}: Kafka`, () => {
  let worker: Worker;
  let jobTopic: Topic;
  let schedulingService: SchedulingService;
  before(async function (): Promise<any> {
    this.timeout(4000);
    worker = new Worker();

    cfg = createServiceConfig(process.cwd() + '/test');
    cfg.set('events:kafka:groupId', testSuffix + 'kafka');
    await worker.start(cfg);

    schedulingService = worker.schedulingService;
    logger = worker.logger;

    jobTopic = await worker.events.topic(JOB_EVENTS_TOPIC);

    if (acsEnv && acsEnv.toLowerCase() === 'true') {
      subject = acsSubject;
      worker.schedulingService.enableAC();
    } else {
      // disable authorization
      cfg.set('authorization:enabled', false);
      cfg.set('authorization:enforce', false);
      updateConfig(cfg);
      subject = {};
    }

    // start acs mock service
    jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
    jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
    mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: jobPolicySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);

    const toDelete = (await schedulingService.read({ request: { subject } }, {})).total_count;
    const jobOffset = await jobTopic.$offset(-1);

    await jobTopic.emit('deleteJobs', { collection: true, subject });

    if (toDelete > 0) {
      await jobTopic.$wait(jobOffset + toDelete - 1);
    }

    payloadShouldBeEmpty(await schedulingService.read({ request: { subject } }, {}));
  });
  beforeEach(async () => {
    for (let event of ['jobsCreated', 'jobsDeleted']) {
      await jobTopic.on(event, () => { });
    }
  });
  afterEach(async () => {
    await jobTopic.removeAllListeners('queuedJob');
    await jobTopic.removeAllListeners('jobsCreated');
    await jobTopic.removeAllListeners('jobsDeleted');
  });
  after(async () => {
    await stopGrpcMockServer(mockServer, logger);
    await jobTopic.removeAllListeners('queuedJob');
    await jobTopic.removeAllListeners('jobsCreated');
    await jobTopic.removeAllListeners('jobsDeleted');
    // await worker.schedulingService.clear();
    // await worker.stop();
  });
  describe('create a one-time job', function postJob(): void {
    this.timeout(15000);
    it('should create a new job and execute it immediately', async () => {
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, type, schedule_type } = job;
        await jobTopic.emit('jobDone', {
          id, type, schedule_type, result: marshallProtobufAny({
            testValue: 'test-value'
          })
        });
      });

      // validate message emitted on jobDone event.
      await jobTopic.on('jobDone', async (job, context, configRet, eventNameRet) => {
        validateJobDonePayload(job);
      });

      const data = {
        timezone: 'Europe/Berlin',
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        data,
        options: {
          timeout: 1,
          priority: Priority.HIGH,
          attempts: 1,
          backoff: {
            type: Backoffs.FIXED,
            delay: 1000,
          }
        }
      } as NewJob;

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: [job], subject });

      // createJobs, queuedJob, jobDone
      await jobTopic.$wait(offset + 3);
      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      // since after creating the job via kafka the authorization will
      // be restored to original value using restoreAC in worker
      // so disable AC to read again
      schedulingService.disableAC();
      const result = await schedulingService.read({ request: { subject } }, {});
      payloadShouldBeEmpty(result);
      should.exist(result.operation_status);
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
    it('should create a new job and execute it at a scheduled time', async () => {
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, type, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, type, schedule_type });
      });

      const data = {
        timezone: 'Europe/Berlin',
        payload:
          marshallProtobufAny({
            testValue: 'test-value'
          })
      };

      // schedule the job to be executed 4 seconds from now.
      // we can specify any Date instance for scheduling the job
      const scheduledTime = new Date();
      scheduledTime.setSeconds(scheduledTime.getSeconds() + 4);
      const job = {
        type: 'test-job',
        data,
        when: scheduledTime.toISOString(),
        options: {
          priority: Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoffs.FIXED,
          },
        }
      } as NewJob;

      const offset = await jobTopic.$offset(-1);

      await jobTopic.emit('createJobs', { items: [job], subject });

      // jobsCreated
      await jobTopic.$wait(offset + 1);

      schedulingService.disableAC();
      let result = await schedulingService.read({
        request: { subject }
      }, {});
      result.items.should.have.length(1);
      result.items[0].payload.type.should.equal('test-job');
      result.items[0].status.code.should.equal(200);
      result.items[0].status.message.should.equal('success');
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');

      // jobsCreated, queuedJob, jobDone
      await jobTopic.$wait(offset + 3);

      schedulingService.disableAC();
      result = await schedulingService.read({
        request: { subject }
      }, {});
      payloadShouldBeEmpty(result);
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
  });

  describe('creating a recurring job', function (): void {
    this.timeout(15000);
    it('should create a recurring job and delete it after some executions', async () => {
      let jobExecs = 0;
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'RECCUR');

        const { id, type, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, type, schedule_type, delete_scheduled: ++jobExecs === 3 });

        // Sleep for jobDone to get processed
        await new Promise(resolve => setTimeout(resolve, 100));

        schedulingService.disableAC();
        let result = await schedulingService.read({ request: { subject } }, {});
        should.exist(result.items);
        result.items.length.should.equal(1);
        result.items[0].payload.type.should.equal('test-job');
        result.items[0].status.code.should.equal(200);
        result.items[0].status.message.should.equal('success');
        result.operation_status.code.should.equal(200);
        result.operation_status.message.should.equal('success');

        if (jobExecs == 3) {
          payloadShouldBeEmpty(result);
          result.operation_status.code.should.equal(200);
          result.operation_status.message.should.equal('success');
        } else {
          result.total_count.should.be.equal(1);
        }
      });

      const data = {
        timezone: 'Europe/Berlin',
        payload:
          marshallProtobufAny({
            testValue: 'test-value'
          })
      };

      const job = {
        type: 'test-job',
        data,
        options: {
          priority: Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoffs.FIXED,
          },
          repeat: {
            every: 2000
          }
        }
      } as NewJob;

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: [job], subject });

      schedulingService.disableAC();
      await new Promise(resolve => setTimeout(resolve, 200));
      const createResponse = await schedulingService.read({ request: { subject } }, {});
      should.exist(createResponse);
      should.exist(createResponse.items);
      createResponse.items.length.should.equal(1);
      createResponse.items[0].payload.type.should.equal('test-job');
      createResponse.items[0].status.code.should.equal(200);
      createResponse.items[0].status.message.should.equal('success');
      createResponse.operation_status.code.should.equal(200);
      createResponse.operation_status.message.should.equal('success');

      // wait for 3 'queuedJob', 3 'jobDone', 1 'createJobs'
      // wait for '1 jobsCreated'
      await jobTopic.$wait(offset + 7);

      // Sleep for jobDone to get processed
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  });

  describe('managing jobs', function (): void {
    this.timeout(15000);
    it('should schedule some jobs for tomorrow', async () => {
      const data = {
        timezone: 'Europe/Berlin',
        payload:
          marshallProtobufAny({
            testValue: 'test-value'
          })
      };

      // schedule the job to be executed 4 seconds from now.
      // we can specify any Date instance for scheduling the job
      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 1);

      const jobs = [];
      for (let i = 0; i < 4; i += 1) {
        jobs[i] = {
          type: 'test-job',
          data,
          when: scheduledTime.toISOString(),
          options: {
            priority: Priority.HIGH,
            attempts: 1,
            backoff: {
              delay: 1000,
              type: Backoffs.FIXED,
            }
          }
        } as NewJob;
      }

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: jobs, subject });

      // jobsCreated
      await jobTopic.$wait(offset + 1);

      schedulingService.disableAC();
      let result = await schedulingService.read({ request: { subject } }, {});
      result.items.map(job => {
        should.exist(job.payload);
        job.payload.type.should.equal('test-job');
        job.status.code.should.equal(200);
        job.status.message.should.equal('success');
      });
      result.total_count.should.be.equal(4);
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
    it('should update / reschedule a job', async () => {
      schedulingService.disableAC();
      let result = await schedulingService.read({ request: { subject } }, {});
      const job = result.items[0].payload;
      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job.when = scheduledTime.toISOString();

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('modifyJobs', {
        items: [job], subject
      });
      await jobTopic.$wait(offset + 1);

      schedulingService.disableAC();
      result = await schedulingService.read({ request: { subject } }, {});
      should.exist(result);
      should.exist(result.items);
      result.items = _.sortBy(result.items, ['id']);
      const updatedJob = _.last(result.items);
      validateJob((updatedJob as any).payload);
    });
    it('should delete all remaining scheduled jobs upon request', async () => {

      await jobTopic.emit('deleteJobs', { collection: true, subject });

      const offset = await jobTopic.$offset(-1);
      await jobTopic.$wait(offset + 2);
      schedulingService.disableAC();
      const result = await schedulingService.read({ request: { subject } }, {});
      payloadShouldBeEmpty(result);
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
  });
});
