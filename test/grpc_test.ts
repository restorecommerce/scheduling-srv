import * as mocha from 'mocha';
import * as should from 'should';
import { marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';
import { Topic } from '@restorecommerce/kafka-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { ServiceClient as SchedulingServiceClient, ServiceDefinition as SchedulingServiceDefinition, JobOptions_Priority, Backoff_Type, JobReadRequest, JobReadRequest_SortOrder, JobList } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job';
import { Logger } from 'winston';
import { GrpcMockServer, ProtoUtils } from '@alenon/grpc-mock-server';
import * as proto_loader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import {
  validateJob,
  payloadShouldBeEmpty,
  validateScheduledJob,
  jobPolicySetRQ,
  permitJobRule,
  denyJobRule,
  validateJobDonePayload
} from './utils';
import { updateConfig } from '@restorecommerce/acs-client';
import * as _ from 'lodash';

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */

const JOB_EVENTS_TOPIC = 'io.restorecommerce.jobs';

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

interface MethodWithOutput {
  method: string,
  output: any
};

const PROTO_PATH: string = 'io/restorecommerce/access_control.proto';
const PKG_NAME: string = 'io.restorecommerce.access_control';
const SERVICE_NAME: string = 'Service';
const pkgDef: grpc.GrpcObject = grpc.loadPackageDefinition(
  proto_loader.loadSync(PROTO_PATH, {
    includeDirs: ['node_modules/@restorecommerce/protos'],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
  })
);

const proto: any = ProtoUtils.getProtoFromPkgDefinition(
  PKG_NAME,
  pkgDef
);

const mockServer = new GrpcMockServer('localhost:50061');

const startGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    isAllowed: (call: any, callback: any) => {
      const isAllowedResponse = methodWithOutput.filter(e => e.method === 'IsAllowed');
      let response: any = new proto.Response.constructor(isAllowedResponse[0].output);
      // Create invalid jobs - DENY
      if (call.request.context && call.request.context.resources && call.request.context.resources.length > 0 && call.request.context.resources[0].value) {
        let resourceObj = JSON.parse(call?.request?.context?.resources[0]?.value?.toString());
        if (resourceObj && resourceObj.id === 'test-invalid-job-id') {
          response = { decision: 'DENY' };
        }
      }
      // Delete request with invalid scope - DENY
      if (call.request && call.request.target && call.request.target.subject && call.request.target.subject.length === 3) {
        let reqSubject = call.request.target.subject;
        if (reqSubject[2]?.id === 'urn:restorecommerce:acs:names:roleScopingInstance' && reqSubject[2]?.value === 'orgD') {
          response = { decision: 'DENY' };
        }
      }
      callback(null, response);
    },
    whatIsAllowed: (call: any, callback: any) => {
      // check the request object and provide UserPolicies / RolePolicies
      const whatIsAllowedResponse = methodWithOutput.filter(e => e.method === 'WhatIsAllowed');
      const response: any = new proto.ReverseQuery.constructor(whatIsAllowedResponse[0].output);
      callback(null, response);
    }
  };
  try {
    mockServer.addService(PROTO_PATH, PKG_NAME, SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos/'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServer.start();
    logger.info('Mock ACS Server started on port 50061');
  } catch (err) {
    logger.error('Error starting mock ACS server', err);
  }
};

const stopGrpcMockServer = async () => {
  await mockServer.stop();
  logger.info('Mock ACS Server closed successfully');
};

describe(`testing scheduling-srv ${testSuffix}: gRPC`, () => {
  let worker: Worker;
  let jobEvents: Topic;
  let grpcSchedulingSrv: SchedulingServiceClient;

  before(async function (): Promise<any> {
    this.timeout(4000);
    worker = new Worker();
    const cfg = createServiceConfig(process.cwd() + '/test');
    cfg.set('events:kafka:groupId', testSuffix + 'grpc');
    await worker.start(cfg);
    logger = worker.logger;

    jobEvents = await worker.events.topic(JOB_EVENTS_TOPIC);

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

    // start acs mock service with PERMIT rule
    jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
    jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
    await startGrpcMockServer([{ method: 'WhatIsAllowed', output: jobPolicySetRQ },
    { method: 'IsAllowed', output: { decision: 'PERMIT' } }]);
    const schedulingClientCfg = cfg.get('client:schedulingClient');
    if (schedulingClientCfg) {
      grpcSchedulingSrv = createClient({
        ...schedulingClientCfg,
        logger
      }, SchedulingServiceDefinition, createChannel(schedulingClientCfg.address));
    }
    const toDelete = (await grpcSchedulingSrv.read({ subject }, {})).total_count;
    const offset = await jobEvents.$offset(-1);

    await grpcSchedulingSrv.delete({ collection: true });

    if (toDelete > 0) {
      await jobEvents.$wait(offset + toDelete - 1);
    }

    payloadShouldBeEmpty(await grpcSchedulingSrv.read({ subject }, {}));
  });
  beforeEach(async () => {
    for (let event of ['jobsCreated', 'jobsDeleted']) {
      await jobEvents.on(event, () => { });
    }
  });
  afterEach(async () => {
    await jobEvents.removeAllListeners('queuedJob');
    await jobEvents.removeAllListeners('jobsCreated');
    await jobEvents.removeAllListeners('jobsDeleted');
  });
  after(async () => {
    await stopGrpcMockServer();
    await jobEvents.removeAllListeners('queuedJob');
    await jobEvents.removeAllListeners('jobsCreated');
    await jobEvents.removeAllListeners('jobsDeleted');
    // await worker.schedulingService.clear();
    // await worker.stop();
  });
  describe(`create a one-time job ${testSuffix}`, function postJob(): void {
    this.timeout(8000);
    it(`should create a new job and execute it immediately ${testSuffix}`, async () => {
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, type, schedule_type } = job;
        await jobEvents.emit('jobDone', {
          id, type, schedule_type, result: marshallProtobufAny({
            testValue: 'test-value'
          })
        });
      });

      // validate message emitted on jobDone event.
      await jobEvents.on('jobDone', async (job, context, configRet, eventNameRet) => {
        validateJobDonePayload(job);
      });

      const data = {
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        data,
        options: {
          timeout: 1,
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            type: Backoff_Type.FIXED,
            delay: 1000,
          }
        }
      };

      const offset = await jobEvents.$offset(-1);
      const createResponse = await grpcSchedulingSrv.create({ items: [job], subject }, {});
      createResponse.items.should.have.length(1);
      createResponse.items[0].payload.type.should.equal('test-job');
      createResponse.items[0].status.code.should.equal(200);
      createResponse.items[0].status.message.should.equal('success');
      createResponse.operation_status.code.should.equal(200);
      createResponse.operation_status.message.should.equal('success');
      // queuedJob (jobDone is emitted from here) - have remvoed jobsDeleted event since we now move the job to completed state
      await jobEvents.$wait(offset + 1);

      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await grpcSchedulingSrv.read({ subject });
      payloadShouldBeEmpty(result);
      createResponse.operation_status.code.should.equal(200);
      createResponse.operation_status.message.should.equal('success');
    });

    it(`should create a new job and execute it at a scheduled time ${testSuffix}`, async () => {
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, type, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, type, schedule_type });
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
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoff_Type.FIXED,
          },
        }
      };

      const offset = await jobEvents.$offset(-1);

      const createResponse = await grpcSchedulingSrv.create({
        items: [job], subject
      }, {});
      createResponse.items.should.have.length(1);
      createResponse.items[0].payload.type.should.equal('test-job');
      createResponse.items[0].status.code.should.equal(200);
      createResponse.items[0].status.message.should.equal('success');
      createResponse.operation_status.code.should.equal(200);
      createResponse.operation_status.message.should.equal('success');

      await jobEvents.$wait(offset + 2); // jobsCreated, queuedJob (jobDone is sent from test)

      const result = await grpcSchedulingSrv.read({ subject }, {});
      payloadShouldBeEmpty(result);
    });
  });
  describe(`should create a recurring job ${testSuffix}`, function (): void {
    this.timeout(8000);
    it(`should create a recurring job and delete it after some executions ${testSuffix}`, async () => {
      let jobExecs = 0;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'RECCUR');

        const { id, type, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, type, schedule_type, delete_scheduled: ++jobExecs === 3 });

        // Sleep for jobDone to get processed
        await new Promise(resolve => setTimeout(resolve, 100));

        let result = await grpcSchedulingSrv.read({ subject }, {});
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
        timezone: "Europe/Berlin",
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        data,
        options: {
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoff_Type.FIXED,
          },
          repeat: {
            every: 2000
          }
        }
      };

      const offset = await jobEvents.$offset(-1);

      const createdJob = await grpcSchedulingSrv.create({
        items: [job], subject
      }, {});
      should.exist(createdJob);
      should.exist(createdJob.items);
      createdJob.items.should.have.length(1);
      createdJob.items[0].payload.type.should.equal('test-job');
      createdJob.items[0].status.code.should.equal(200);
      createdJob.items[0].status.message.should.equal('success');
      createdJob.operation_status.code.should.equal(200);
      createdJob.operation_status.message.should.equal('success');

      // wait for 3 'queuedJob', 3 'jobDone'
      await jobEvents.$wait(offset + 6);

      // Sleep for jobDone to get processed
      await new Promise(resolve => setTimeout(resolve, 100));
    });
    it('should create a recurring job based on id and remove on completed', async () => {
      const data = {
        timezone: "Europe/Berlin",
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };
      const job = {
        id: 'test-job-id',
        type: 'test-job',
        data,
        options: {
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoff_Type.FIXED,
          },
          repeat: {
            cron: '*/2 * * * * *'  // every two seconds
          },
          removeOnComplete: true
        }
      };
      const createdJob = await grpcSchedulingSrv.create({
        items: [job], subject
      }, {});

      should.exist(createdJob);
      createdJob.items.should.have.length(1);
      createdJob.items[0].payload.type.should.equal('test-job');
      createdJob.items[0].status.code.should.equal(200);
      createdJob.items[0].status.message.should.equal('success');
      createdJob.operation_status.code.should.equal(200);
      createdJob.operation_status.message.should.equal('success');
    });
    it('should delete a recurring job based on provided id and throw an error on read operation', async () => {
      const deletedJob = await grpcSchedulingSrv.delete({
        ids: ['test-job-id'], subject
      }, {});
      deletedJob.status[0].id.should.equal('test-job-id');
      deletedJob.status[0].code.should.equal(200);
      deletedJob.status[0].message.should.equal('success');
      deletedJob.operation_status.code.should.equal(200);
      deletedJob.operation_status.message.should.equal('success');
      const result = await grpcSchedulingSrv.read({ filter: { job_ids: ['test-job-id'] }, subject }, {});
      result.items[0].status.id.should.equal('test-job-id');
      result.items[0].status.code.should.equal(404);
      result.items[0].status.message.should.equal('Job ID test-job-id not found in any of the queues');
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
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
            priority: JobOptions_Priority.HIGH,
            attempts: 1,
            backoff: {
              delay: 1000,
              type: Backoff_Type.FIXED,
            }
          }
        };
      }

      const createResponse = await grpcSchedulingSrv.create({
        items: jobs, subject
      }, {});
      should.exist(createResponse);
      should.exist(createResponse.items);
      createResponse.items.should.have.length(4);
      createResponse.items[0].payload.type.should.equal('test-job');
      createResponse.items[0].status.code.should.equal(200);
      createResponse.items[0].status.message.should.equal('success');
      createResponse.operation_status.code.should.equal(200);
      createResponse.operation_status.message.should.equal('success');
    });
    it(`should retrieve all job properties correctly with empty filter ${testSuffix}`, async () => {
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ sort: JobReadRequest_SortOrder.DESCENDING, subject }), {});
      should.exist(result);
      should.exist(result.items);
      result.items.should.be.length(4);
      result.items.forEach((job) => {
        validateJob(job.payload);
        job.status.code.should.equal(200);
        job.status.message.should.equal('success');
      });
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
    it(`should retrieve all job properties correctly with filter type or id ${testSuffix}`, async () => {
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ filter: { type: 'test-job' }, sort: JobReadRequest_SortOrder.ASCENDING, subject }), {});
      should.exist(result);
      should.exist(result.items);
      result.items.should.be.length(4);
      result.items.forEach((job) => {
        validateJob(job.payload);
        job.status.code.should.equal(200);
        job.status.message.should.equal('success');
      });
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');

      const result_id_type = await grpcSchedulingSrv.read({
        filter: { type: 'test-job', job_ids: [result.items[0].payload.id] },
        subject
      }, {});
      should.exist(result_id_type);
      should.exist(result_id_type.items);
      result_id_type.items.should.be.length(1);
      result_id_type.items.forEach((job) => {
        validateJob(job.payload);
        job.status.code.should.equal(200);
        job.status.message.should.equal('success');
      });
      result_id_type.operation_status.code.should.equal(200);
      result_id_type.operation_status.message.should.equal('success');

      const result_id = await grpcSchedulingSrv.read({
        filter: { job_ids: [result.items[0].payload.id] },
        subject
      }, {});
      should.exist(result_id);
      should.exist(result_id.items);
      result_id.items.should.be.length(1);
      result_id.items.forEach((job) => {
        validateJob(job.payload);
        job.status.code.should.equal(200);
        job.status.message.should.equal('success');
      });
    });
    it(`should update / reschedule a job ${testSuffix}`, async () => {
      let result = await grpcSchedulingSrv.read({ subject }, {});
      const job = result.items[0].payload;

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job.when = scheduledTime.toISOString();

      const offset = await jobEvents.$offset(-1);
      result = await grpcSchedulingSrv.update({
        items: [job], subject
      });

      should.exist(result);
      should.exist(result.items);
      result.items.should.have.length(1);

      const updatedJob = result.items[0];
      validateJob(updatedJob.payload);
      updatedJob.status.code.should.equal(200);
      updatedJob.status.message.should.equal('success');
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
      // waiting for event creation
      await jobEvents.$wait(offset + 1);
    });
    it(`should upsert a job ${testSuffix}`, async () => {
      let result = await grpcSchedulingSrv.read({ subject }, {});
      const job = result.items[0].payload;

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 3); // three days from now
      job.when = scheduledTime.toISOString();

      const offset = await jobEvents.$offset(-1);
      result = await grpcSchedulingSrv.upsert({
        items: [job], subject
      });
      should.exist(result);
      should.exist(result.items);
      result.items.should.have.length(1);

      const upsertedJob = result.items[0];
      validateJob(upsertedJob.payload);
      upsertedJob.status.code.should.equal(200);
      upsertedJob.status.message.should.equal('success');
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
      // waiting for event creation
      await jobEvents.$wait(offset + 1);
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
        id: 'test-invalid-job-id',
        type: 'test-invalid-job',
        data,
        options: {
          timeout: 1,
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            type: Backoff_Type.FIXED,
            delay: 1000,
          }
        }
      };
      it(`should throw an error when creating a new job with invalid scope ${testSuffix}`, async () => {
        // // restart mock service with DENY rules
        // jobPolicySetRQ.policy_sets[0].policies[0].effect = 'DENY';
        // jobPolicySetRQ.policy_sets[0].policies[0].rules = [denyJobRule];
        subject.scope = 'orgD';
        let result = await grpcSchedulingSrv.create({ items: [job], subject }, {});
        result.operation_status.code.should.equal(403);
        result.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:CREATE, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error retreiving job properties with empty filter with invalid scope ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.read({ sort: JobReadRequest_SortOrder.DESCENDING, subject }, {});
        result.operation_status.code.should.equal(403);
        result.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:READ, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error when updating / rescheduling a job with invalid scope ${testSuffix}`, async () => {
        const scheduledTime = new Date();
        scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
        (job as any).when = scheduledTime.toISOString();
        const result = await grpcSchedulingSrv.update(JobList.fromPartial({
          items: [job], subject
        }));
        result.operation_status.code.should.equal(403);
        result.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:MODIFY, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error when upserting a job with invalid scope ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.upsert({
          items: [job], subject
        });
        result.operation_status.code.should.equal(403);
        result.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:MODIFY, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error deleting jobs ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.delete({
          collection: true, subject
        }, {});
        result.operation_status.code.should.equal(403);
        result.operation_status.message.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:DROP, target_scope:orgD; the response was DENY');
      });
    }
    it(`should delete all remaining scheduled jobs upon request ${testSuffix}`, async () => {
      // // restart mock service with PERMIT rules
      // jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
      // jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
      subject.scope = 'orgC';
      await grpcSchedulingSrv.delete({
        collection: true, subject
      }, {});
      const result = await grpcSchedulingSrv.read({ subject }, {});
      payloadShouldBeEmpty(result);
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
  });
});
