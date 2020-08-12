import * as _ from 'lodash';
import * as mocha from 'mocha';
import * as should from 'should';

import { SchedulingService, marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';

import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

import {
  validateJobResource,
  shouldBeEmpty, validateScheduledJob, jobPolicySetRQ, startGrpcMockServer, stopGrpcMockServer, permitJobRule
} from './utils';
import { Backoffs, NewJob, Priority } from "../lib/types";
import { Logger } from '@restorecommerce/chassis-srv';
import { updateConfig } from '@restorecommerce/acs-client';

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */


const QUEUED_JOBS_TOPIC = 'io.restorecommerce.jobs';
const JOB_RESOURCE_TOPIC = 'io.restorecommerce.jobs.resource';

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
  let jobResourceTopic: Topic;
  let schedulingService: SchedulingService;
  before(async function (): Promise<any> {
    this.timeout(4000);
    worker = new Worker();

    cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);

    schedulingService = worker.schedulingService;
    logger = worker.logger;

    jobTopic = worker.events.topic(QUEUED_JOBS_TOPIC);
    jobResourceTopic = worker.events.topic(JOB_RESOURCE_TOPIC);

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

    // strat acs mock service
    jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
    jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
    mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: jobPolicySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);

    const toDelete = (await schedulingService.read({ request: { subject } }, {})).total_count;
    const jobResourceOffset = await jobResourceTopic.$offset(-1);

    await jobTopic.emit('deleteJobs', { collection: true, subject });

    if (toDelete > 0) {
      await jobResourceTopic.$wait(jobResourceOffset + toDelete - 1);
    }

    shouldBeEmpty(await schedulingService.read({ request: { subject } }, {}));
  });
  beforeEach(async () => {
    for (let event of ['jobsCreated', 'jobsDeleted']) {
      await jobResourceTopic.on(event, () => { });
    }
  });
  afterEach(async () => {
    await jobTopic.removeAllListeners('queuedJob');
    await jobResourceTopic.removeAllListeners('jobsCreated');
    await jobResourceTopic.removeAllListeners('jobsDeleted');
  });
  after(async () => {
    await stopGrpcMockServer(mockServer, logger);
    await jobTopic.removeAllListeners('queuedJob');
    await jobResourceTopic.removeAllListeners('jobsCreated');
    await jobResourceTopic.removeAllListeners('jobsDeleted');
    // await worker.schedulingService.clear();
    // await worker.stop();
  });
  describe('create a one-time job', function postJob(): void {
    this.timeout(15000);
    it('should create a new job and execute it immediately', async () => {
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, schedule_type });
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

      await jobTopic.$wait(offset + 2); // createJobs, queued, jobDone

      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      // since after creating the job via kafka the authorization will
      // be restored to original value using restoreAC in worker
      // so disable AC to read again
      schedulingService.disableAC();
      const result = await schedulingService.read({ request: { subject } });
      shouldBeEmpty(result);
    });
    it('should create a new job and execute it at a scheduled time', async () => {
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, schedule_type });
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
      const jobResourceOffset = await jobResourceTopic.$offset(-1);

      await jobTopic.emit('createJobs', { items: [job], subject });

      await jobResourceTopic.$wait(jobResourceOffset);

      schedulingService.disableAC();
      let result = await schedulingService.read({
        request: { subject }
      });
      result.items.should.have.length(1);

      await jobTopic.$wait(offset + 2);
      await jobResourceTopic.$wait(jobResourceOffset + 1);

      schedulingService.disableAC();
      result = await schedulingService.read({
        request: { subject }
      });
      shouldBeEmpty(result);
    });
  });

  describe('creating a recurring job', function (): void {
    this.timeout(15000);
    it('should create a recurring job and delete it after some executions', async () => {
      let jobExecs = 0;
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'RECCUR');

        const { id, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, schedule_type, delete_scheduled: ++jobExecs === 3 });

        // Sleep for jobDone to get processed
        await new Promise(resolve => setTimeout(resolve, 100));

        schedulingService.disableAC();
        let result = await schedulingService.read({ request: { subject } }, {});
        should.exist(result);

        if (jobExecs == 3) {
          shouldBeEmpty(result);
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

      const jobOffset = await jobTopic.$offset(-1);
      const jobResourceOffset = await jobResourceTopic.$offset(-1);

      await jobTopic.emit('createJobs', { items: [job], subject });

      // wait for 'jobsCreated'
      await jobResourceTopic.$wait(jobResourceOffset);

      schedulingService.disableAC();
      const created = await schedulingService.read({ request: { subject } }, {});
      should.exist(created);
      should.exist(created.items);

      // wait for 3 'queuedJob', 3 'jobDone', 1 'createJobs'
      await jobTopic.$wait(jobOffset + 6);

      // wait for 'jobsDeleted', 'jobsCreated'
      await jobResourceTopic.$wait(jobResourceOffset + 1);

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

      const jobResourceOffset = await jobResourceTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: jobs, subject });

      await jobResourceTopic.$wait(jobResourceOffset + 3);

      schedulingService.disableAC();
      let result = await schedulingService.read({ request: { subject } }, {});
      result.total_count.should.be.equal(4);
    });
    it('should update / reschedule a job', async () => {
      schedulingService.disableAC();
      let result = await schedulingService.read({ request: { subject } }, {});
      const job = result.items[0];

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job.when = scheduledTime.toISOString();

      const jobResourceOffset = await jobResourceTopic.$offset(-1);
      await jobTopic.emit('modifyJobs', {
        items: [job], subject
      });
      await jobResourceTopic.$wait(jobResourceOffset + 1);

      schedulingService.disableAC();
      result = await schedulingService.read({ request: { subject } }, {});
      should.exist(result);
      should.exist(result.items);
      result.items = _.sortBy(result.items, ['id']);
      const updatedJob = _.last(result.items);
      validateJobResource(updatedJob);
      // waiting for event creation
    });
    it('should delete all remaining scheduled jobs upon request', async () => {

      await jobTopic.emit('deleteJobs', { collection: true, subject });

      const jobResourceOffset = await jobResourceTopic.$offset(-1);
      await jobResourceTopic.$wait(jobResourceOffset + 3);
      schedulingService.disableAC();
      const result = await schedulingService.read({ request: { subject } }, {});
      shouldBeEmpty(result);
    });
  });
});
