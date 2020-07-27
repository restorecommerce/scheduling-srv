import * as mocha from 'mocha';
import * as should from 'should';
import { marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import { Client } from '@restorecommerce/grpc-client';
import { Logger } from '@restorecommerce/logger';
import {
  validateJobResource, shouldBeEmpty, validateScheduledJob, jobPolicySetRQ,
  startGrpcMockServer, stopGrpcMockServer, permitJobRule, denyJobRule
} from './utils';
import { Backoffs, Priority, SortOrder, NewJob } from "../lib/types";
import { updateConfig } from '@restorecommerce/acs-client';
import * as _ from 'lodash';

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */

const QUEUED_JOBS_TOPIC = 'io.restorecommerce.jobs';
const JOB_RESOURCE_TOPIC = 'io.restorecommerce.jobs.resource';

let mockServer: any;
let logger: Logger;
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

describe(`testing scheduling-srv ${testSuffix}: gRPC`, () => {
  let worker: Worker;
  let jobEvents: Topic;
  let jobResourceEvents: Topic;
  let serviceClient: Client;
  let grpcSchedulingSrv: any;

  before(async function (): Promise<any> {
    this.timeout(4000);
    worker = new Worker();
    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);
    logger = worker.logger;

    jobEvents = worker.events.topic(QUEUED_JOBS_TOPIC);
    jobResourceEvents = worker.events.topic(JOB_RESOURCE_TOPIC);

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

    // strat acs mock service with PERMIT rule
    jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
    jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
    mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: jobPolicySetRQ },
    { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);
    serviceClient = new Client(cfg.get('client:schedulingClient'), logger);
    grpcSchedulingSrv = await serviceClient.connect();
    const toDelete = (await grpcSchedulingSrv.read({ subject }, {})).total_count;
    const jobResourceOffset = await jobResourceEvents.$offset(-1);

    await grpcSchedulingSrv.delete({ collection: true });

    if (toDelete > 0) {
      await jobResourceEvents.$wait(jobResourceOffset + toDelete - 1);
    }

    shouldBeEmpty(await grpcSchedulingSrv.read({ subject }, {}));
  });
  beforeEach(async () => {
    for (let event of ['jobsCreated', 'jobsDeleted']) {
      await jobResourceEvents.on(event, () => { });
    }
  });
  afterEach(async () => {
    await jobEvents.removeAllListeners('queuedJob');
    await jobResourceEvents.removeAllListeners('jobsCreated');
    await jobResourceEvents.removeAllListeners('jobsDeleted');
  });
  after(async () => {
    await stopGrpcMockServer(mockServer, logger);
    await jobEvents.removeAllListeners('queuedJob');
    await jobResourceEvents.removeAllListeners('jobsCreated');
    await jobResourceEvents.removeAllListeners('jobsDeleted');
    await worker.schedulingService.clear();
    await worker.stop();
    await serviceClient.end();
  });
  describe(`create a one-time job ${testSuffix}`, function postJob(): void {
    this.timeout(8000);
    it(`should create a new job and execute it immediately ${testSuffix}`, async () => {
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, schedule_type });
      });
      const data = {
        timezone: "Europe/Berlin",
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

      const offset = await jobEvents.$offset(-1);
      await grpcSchedulingSrv.create({ items: [job], subject }, {});

      await jobEvents.$wait(offset); // queued, jobDone

      await jobEvents.$wait(offset + 1); // queued, jobDone

      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await grpcSchedulingSrv.read({ subject });
      shouldBeEmpty(result);
    });

    it(`should create a new job and execute it at a scheduled time ${testSuffix}`, async () => {
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, schedule_type });
      });

      const data = {
        timezone: "Europe/Berlin",
        payload: marshallProtobufAny({
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

      const offset = await jobEvents.$offset(-1);
      const jobResourceOffset = await jobResourceEvents.$offset(-1);

      await grpcSchedulingSrv.create({
        items: [job], subject
      }, {});

      await jobResourceEvents.$wait(jobResourceOffset + 1);
      await jobEvents.$wait(offset + 1);

      const result = await grpcSchedulingSrv.read({ subject }, {});
      shouldBeEmpty(result);
    });
  });
  describe(`should create a recurring job ${testSuffix}`, function (): void {
    this.timeout(8000);
    it(`should create a recurring job and delete it after some executions ${testSuffix}`, async () => {
      let jobExecs = 0;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'RECCUR');

        const { id, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, schedule_type, delete_scheduled: ++jobExecs === 3 });

        // Sleep for jobDone to get processed
        await new Promise(resolve => setTimeout(resolve, 100));

        let result = await grpcSchedulingSrv.read({ subject }, {});
        should.exist(result);

        if (jobExecs == 3) {
          shouldBeEmpty(result);
        } else {
          result.data.total_count.should.be.equal(1);
        }
      });

      const data = {
        timezone: "Europe/Berlin",
        payload: marshallProtobufAny({
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

      const jobOffset = await jobEvents.$offset(-1);
      const jobResourceOffset = await jobResourceEvents.$offset(-1);

      const createdJob = await grpcSchedulingSrv.create({
        items: [job], subject
      }, {});

      should.exist(createdJob);
      should.exist(createdJob.data);
      should.exist(createdJob.data.items);
      createdJob.data.items.should.have.length(1);

      // wait for 3 'queuedJob' and 3 'jobDone' events
      await jobEvents.$wait(jobOffset + 5);
      // wait for 'jobsCreated' and 'jobsDeleted' events
      await jobResourceEvents.$wait(jobResourceOffset + 1);

      // Sleep for jobDone to get processed
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  });
  describe(`managing jobs ${testSuffix}`, function (): void {
    this.timeout(5000);
    it('should schedule some jobs for tomorrow', async () => {
      const data = {
        timezone: "Europe/Berlin",
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      // schedule the job to be executed tomorrow
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

      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      const newVar = await grpcSchedulingSrv.create({
        items: jobs, subject
      }, {});

      await jobResourceEvents.$wait(jobResourceOffset + 3);
    });
    it(`should retrieve all job properties correctly with empty filter ${testSuffix}`, async () => {
      const result = await grpcSchedulingSrv.read({ sort: SortOrder.DESCENDING, subject }, {});
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.be.length(4);
      result.data.items.forEach((job) => {
        validateJobResource(job);
      });
    });
    it(`should retrieve all job properties correctly with filter type or id ${testSuffix}`, async () => {
      const result = await grpcSchedulingSrv.read({ filter: { type: 'test-job' }, sort: 'ASCENDING', subject }, {});
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.be.length(4);
      result.data.items.forEach((job) => {
        validateJobResource(job);
      });

      const result_id_type = await grpcSchedulingSrv.read({
        filter: { type: 'test-job', job_ids: result.data.items[0].id },
        subject
      }, {});
      should.exist(result_id_type);
      should.exist(result_id_type.data);
      should.exist(result_id_type.data.items);
      result_id_type.data.items.should.be.length(1);
      result_id_type.data.items.forEach((job) => {
        validateJobResource(job);
      });

      const result_id = await grpcSchedulingSrv.read({
        filter: { job_ids: result.data.items[0].id },
        subject
      }, {});
      should.exist(result_id);
      should.exist(result_id.data);
      should.exist(result_id.data.items);
      result_id.data.items.should.be.length(1);
      result_id.data.items.forEach((job) => {
        validateJobResource(job);
      });
    });
    it(`should update / reschedule a job ${testSuffix}`, async () => {
      let result = await grpcSchedulingSrv.read({ subject }, {});
      const job = result.data.items[0];

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job.when = scheduledTime.toISOString();

      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      result = await grpcSchedulingSrv.update({
        items: [job], subject
      });

      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.have.length(1);

      const updatedJob = result.data.items[0];
      validateJobResource(updatedJob);
      // waiting for event creation
      await jobResourceEvents.$wait(jobResourceOffset + 1);
    });
    it(`should upsert a job ${testSuffix}`, async () => {
      let result = await grpcSchedulingSrv.read({ subject }, {});
      const job = result.data.items[0];

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 3); // three days from now
      job.when = scheduledTime.toISOString();

      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      result = await grpcSchedulingSrv.upsert({
        items: [job], subject
      });
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.have.length(1);

      const upsertedJob = result.data.items[0];
      validateJobResource(upsertedJob);
      // waiting for event creation
      await jobResourceEvents.$wait(jobResourceOffset + 1);
    });
    // -ve test cases to be run when ACS is enabled
    // set subject target scope to invlaid scope not present in subject's HR scope
    if (acsEnabled) {
      const data = {
        timezone: "Europe/Berlin",
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-invalid-job',
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
      it(`should throw an error when creating a new job with invalid scope ${testSuffix}`, async () => {
        // restart mock service with DENY rules 
        jobPolicySetRQ.policy_sets[0].policies[0].effect = 'DENY';
        jobPolicySetRQ.policy_sets[0].policies[0].rules = [denyJobRule];
        await stopGrpcMockServer(mockServer, logger);
        mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: jobPolicySetRQ },
        { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'DENY' } }], logger);
        subject.scope = 'orgD';
        let result = await grpcSchedulingSrv.create({ items: [job], subject }, {});
        should.exist(result.error);
        result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:job, action:CREATE, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error retreiving job properties with empty filter with invalid scope ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.read({ sort: SortOrder.DESCENDING, subject }, {});
        should.exist(result.error);
        result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:job, action:READ, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error when updating / rescheduling a job with invalid scope ${testSuffix}`, async () => {
        const scheduledTime = new Date();
        scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
        job.when = scheduledTime.toISOString();
        const result = await grpcSchedulingSrv.update({
          items: [job], subject
        });
        should.exist(result.error);
        // READ action error is thrown since the job needs to be read first before updating
        result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:job, action:READ, target_scope:orgD; the response was DENY');
      });
      it(`should upsert a job ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.upsert({
          items: [job], subject
        });
        should.exist(result.error);
        // READ action error is thrown since the job needs to be read first before upserting
        result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:job, action:READ, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error deleting jobs ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.delete({
          collection: true, subject
        }, {});
        result.error.details.should.equal('7 PERMISSION_DENIED: Access not allowed for request with subject:admin_user_id, resource:job, action:DROP, target_scope:orgD; the response was DENY');
      });
    }
    it(`should delete all remaining scheduled jobs upon request ${testSuffix}`, async () => {
      // restart mock service with PERMIT rules
      jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
      await stopGrpcMockServer(mockServer, logger);
      mockServer = await startGrpcMockServer([{ method: 'WhatIsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: jobPolicySetRQ },
      { method: 'IsAllowed', input: '\{.*\:\{.*\:.*\}\}', output: { decision: 'PERMIT' } }], logger);
      subject.scope = 'orgC';
      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      await grpcSchedulingSrv.delete({
        collection: true, subject
      }, {});
      const result = await grpcSchedulingSrv.read({ subject }, {});
      shouldBeEmpty(result);
      await jobResourceEvents.$wait(jobResourceOffset + 3);
    });
  });
});
