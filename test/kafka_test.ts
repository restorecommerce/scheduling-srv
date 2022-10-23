import * as _ from 'lodash';
import * as mocha from 'mocha';
import * as should from 'should';

import { SchedulingService, marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';

import { Topic } from '@restorecommerce/kafka-client';
import { createServiceConfig } from '@restorecommerce/service-config';
import { GrpcMockServer, ProtoUtils } from '@alenon/grpc-mock-server';
import * as proto_loader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import {
  validateJob,
  payloadShouldBeEmpty,
  validateScheduledJob,
  jobPolicySetRQ,
  permitJobRule,
  validateJobDonePayload
} from './utils';
import { createClient as RedisCreateClient, RedisClientType } from 'redis';
import { Logger } from 'winston';
import { updateConfig } from '@restorecommerce/acs-client';
import { JobOptions_Priority, Backoff_Type, JobReadRequest } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job';

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */


const JOB_EVENTS_TOPIC = 'io.restorecommerce.jobs';

let logger: Logger;
let cfg;
let subject;
let redisClient: RedisClientType;
let tokenRedisClient: RedisClientType;
// mainOrg -> orgA -> orgB -> orgC
const acsSubject = {
  id: 'admin_user_id',
  scope: 'orgC',
  token: 'admin_token',
  tokens: [{ token: 'admin_token', expires_in: 0 }],
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
      const response: any = new proto.Response.constructor(isAllowedResponse[0].output);
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

const IDS_PROTO_PATH = 'test/protos/io/restorecommerce/user.proto';
const IDS_PKG_NAME = 'io.restorecommerce.user';
const IDS_SERVICE_NAME = 'Service';

const mockServerIDS = new GrpcMockServer('localhost:50051');

// Mock server for ids - findByToken
const startIDSGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  const implementations = {
    findByToken: (call: any, callback: any) => {
      if (call.request.token === 'admin_token') {
        // admin user
        callback(null, { payload: acsSubject, status: { code: 200, message: 'success' } });
      }
    }
  };
  try {
    mockServerIDS.addService(IDS_PROTO_PATH, IDS_PKG_NAME, IDS_SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos/'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServerIDS.start();
    logger.info('Mock IDS Server started on port 50051');
  } catch (err) {
    logger.error('Error starting mock IDS server', err);
  }
};

const stopGrpcMockServer = async () => {
  await mockServer.stop();
  logger.info('Mock ACS Server closed successfully');
};

const stopIDSGrpcMockServer = async () => {
  await mockServerIDS.stop();
  logger.info('Mock IDS Server closed successfully');
};

describe(`testing scheduling-srv ${testSuffix}: Kafka`, async () => {
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

    // start acs mock service
    jobPolicySetRQ.policy_sets[0].policies[0].effect = 'PERMIT';
    jobPolicySetRQ.policy_sets[0].policies[0].rules = [permitJobRule];
    // start mock acs-srv - needed for read operation since acs-client makes a req to acs-srv
    // to get applicable policies although acs-lookup is disabled
    await startGrpcMockServer([{ method: 'WhatIsAllowed', output: jobPolicySetRQ },
    { method: 'IsAllowed', output: { decision: 'PERMIT' } }]);
    jobTopic = await worker.events.topic(JOB_EVENTS_TOPIC);

    // start mock ids-srv needed for findByToken response and return subject
    await startIDSGrpcMockServer([{ method: 'findByToken', output: acsSubject }]);

    // set redis client
    // since its not possible to mock findByToken as it is same service, storing the token value with subject
    // HR scopes resolved to db-subject redis store and token to findByToken redis store
    const redisConfig = cfg.get('redis');
    redisConfig.database = cfg.get('redis:db-indexes:db-subject') || 0;
    redisClient = RedisCreateClient(redisConfig);
    redisClient.on('error', (err) => logger.error('Redis Client Error', err));
    await redisClient.connect();

    // for findByToken
    redisConfig.database = cfg.get('redis:db-indexes:db-findByToken') || 0;
    tokenRedisClient = RedisCreateClient(redisConfig);
    tokenRedisClient.on('error', (err) => logger.error('Redis client error in token cache store', err));
    await tokenRedisClient.connect();

    // store hrScopesKey and subjectKey to Redis index `db-subject`
    const hrScopeskey = `cache:${acsSubject.id}:${acsSubject.token}:hrScopes`;
    const subjectKey = `cache:${acsSubject.id}:subject`;
    await redisClient.set(subjectKey, JSON.stringify(acsSubject));
    await redisClient.set(hrScopeskey, JSON.stringify(acsSubject.hierarchical_scopes));

    // store user with tokens and role associations to Redis index `db-findByToken`
    await tokenRedisClient.set('admin-token', JSON.stringify(acsSubject));

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

    const toDelete = (await schedulingService.read(JobReadRequest.fromPartial({ subject }), {})).total_count;
    const jobOffset = await jobTopic.$offset(-1);

    await jobTopic.emit('deleteJobs', { collection: true, subject });

    if (toDelete > 0) {
      await jobTopic.$wait(jobOffset + toDelete - 1);
    }

    payloadShouldBeEmpty(await schedulingService.read(JobReadRequest.fromPartial({ subject }), {}));
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
    await stopGrpcMockServer();
    await stopIDSGrpcMockServer();
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
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            type: Backoff_Type.FIXED,
            delay: 1000,
          }
        }
      };

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
      const result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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
          priority: JobOptions_Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoff_Type.FIXED,
          },
        }
      };

      const offset = await jobTopic.$offset(-1);

      await jobTopic.emit('createJobs', { items: [job], subject });

      // jobsCreated
      await jobTopic.$wait(offset + 1);

      schedulingService.disableAC();
      let result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
      result.items.should.have.length(1);
      result.items[0].payload.type.should.equal('test-job');
      result.items[0].status.code.should.equal(200);
      result.items[0].status.message.should.equal('success');
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');

      // jobsCreated, queuedJob, jobDone
      await jobTopic.$wait(offset + 3);

      schedulingService.disableAC();
      result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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
        let result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: [job], subject });

      schedulingService.disableAC();
      await new Promise(resolve => setTimeout(resolve, 200));
      const createResponse = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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
            priority: JobOptions_Priority.HIGH,
            attempts: 1,
            backoff: {
              delay: 1000,
              type: Backoff_Type.FIXED,
            }
          }
        };
      }

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: jobs, subject });

      // jobsCreated
      await jobTopic.$wait(offset + 1);

      schedulingService.disableAC();
      let result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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
      let result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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
      result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
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
      const result = await schedulingService.read(JobReadRequest.fromPartial({ subject }), {});
      payloadShouldBeEmpty(result);
      result.operation_status.code.should.equal(200);
      result.operation_status.message.should.equal('success');
    });
  });
});
