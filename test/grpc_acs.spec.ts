import {} from 'mocha';
import should from 'should';
import { marshallProtobufAny } from '../src/utilts.js';
import { Worker } from '../src/worker.js';
import { Topic } from '@restorecommerce/kafka-client';
import { 
  JobServiceDefinition as SchedulingServiceDefinition,
  JobServiceClient as SchedulingServiceClient,
  JobOptions_Priority,
  Backoff_Type,
  JobReadRequest,
  JobReadRequest_SortOrder,
  JobList,
  Job
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job.js';
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
  validateJobDonePayload,
  cfg,
  getSchedulingServiceClient
} from './utils.js';
import { updateConfig } from '@restorecommerce/acs-client';
import * as _ from 'lodash-es';
import { DeleteRequest } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { createClient as RedisCreateClient, RedisClientType } from 'redis';
import { runWorker } from '@restorecommerce/scs-jobs';
import { Effect } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rule.js';
import { it, describe, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */

const JOB_EVENTS_TOPIC = 'io.restorecommerce.jobs';

let logger: Logger;
let subject;
let redisClient: RedisClientType;
let tokenRedisClient: RedisClientType;
let expires_in = new Date();
expires_in.setDate(expires_in.getDate() + 1);
// mainOrg -> orgA -> orgB -> orgC
const acsSubject = {
  id: 'admin_user_id',
  scope: 'orgC',
  role_associations: [
    {
      role: 'admin-r-id',
      attributes: [{
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization',
        attributes: [{
          id: 'urn:restorecommerce:acs:names:roleScopingInstance',
          value: 'mainOrg',
          attributes: []
        }]
      }]
    }
  ],
  token: 'admin_token',
  tokens: [{ token: 'admin_token', expires_in }],
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
const acsEnv = 'true';
let acsEnabled = true;
let testSuffix = 'with ACS Enabled';

interface MethodWithOutput {
  method: string;
  output: any;
};

const PROTO_PATH = 'io/restorecommerce/access_control.proto';
const PKG_NAME = 'io.restorecommerce.access_control';
const SERVICE_NAME = 'AccessControlService';
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

let mockServerACS: GrpcMockServer;
const startACSGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  mockServerACS = new GrpcMockServer(cfg.get('client:acs-srv:address'));
  const implementations = {
    isAllowed: (call: any, callback: any) => {
      const isAllowedResponse = methodWithOutput.filter(e => e.method === 'IsAllowed');
      let response: any = new proto.Response.constructor(isAllowedResponse[0].output);
      // Create invalid jobs - DENY
      if (call.request.context && call.request.context.resources && call.request.context.resources.length > 0 && call.request.context.resources[0].value) {
        let resourceObj = JSON.parse(call?.request?.context?.resources[0]?.value?.toString());
        if (resourceObj && resourceObj.id === 'test-invalid-job-id') {
          response = { decision: Effect.DENY };
        }
      }
      // Delete request with invalid scope - DENY
      if (call?.request?.target?.subjects?.length === 2) {
        let reqSubject = call.request.target.subjects;
        if (reqSubject[1]?.id === 'urn:restorecommerce:acs:names:roleScopingInstance' && reqSubject[1]?.value === 'orgD') {
          response = { decision: Effect.DENY };
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
    mockServerACS.addService(PROTO_PATH, PKG_NAME, SERVICE_NAME, implementations, {
      includeDirs: ['node_modules/@restorecommerce/protos/'],
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    await mockServerACS.start();
    logger.info(`Mock ACS Server started on ${mockServerACS.serverAddress}`);
  } catch (err) {
    logger.error('Error starting mock ACS server', err);
  }
  return mockServerACS;
};

const IDS_PROTO_PATH = 'io/restorecommerce/user.proto';
const IDS_PKG_NAME = 'io.restorecommerce.user';
const IDS_SERVICE_NAME = 'UserService';

// Mock server for ids - findByToken
let mockServerIDS: GrpcMockServer;
const startIDSGrpcMockServer = async (methodWithOutput: MethodWithOutput[]) => {
  // create mock implementation based on the method name and output
  mockServerIDS = new GrpcMockServer(cfg.get('client:user:address'));
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
    logger.info(`Mock IDS Server started on ${mockServerIDS.serverAddress}`);
  } catch (err) {
    logger.error('Error starting mock IDS server', err);
  }
  return mockServerIDS;
};


const stopACSGrpcMockServer = async () => {
  await mockServerACS?.stop();
  logger.info('Mock ACS Server closed successfully');
};

const stopIDSGrpcMockServer = async () => {
  await mockServerIDS?.stop();
  logger.info('Mock IDS Server closed successfully');
};

describe(`testing scheduling-srv ${testSuffix}: gRPC`, () => {
  let worker: Worker;
  let jobEvents: Topic;
  let grpcSchedulingSrv: SchedulingServiceClient;

  beforeAll(async function (): Promise<any> {
    this.timeout(40000);
    worker = new Worker();
    cfg.set('events:kafka:groupId', testSuffix + 'grpc');
    await worker.start(cfg);
    logger = worker.logger;

    jobEvents = await worker.events.topic(JOB_EVENTS_TOPIC);

    if (acsEnv && acsEnv.toLowerCase() === 'true') {
      subject = acsSubject;
    } else {
      // disable authorization
      cfg.set('authorization:enabled', false);
      cfg.set('authorization:enforce', false);
      updateConfig(cfg);
      subject = {};
    }

    // start acs mock service with PERMIT rule
    jobPolicySetRQ.policy_sets![0]!.policies![0]!.effect = Effect.PERMIT;
    jobPolicySetRQ.policy_sets![0]!.policies![0]!.rules = [permitJobRule];
    await startACSGrpcMockServer([
      {
        method: 'WhatIsAllowed',
        output: jobPolicySetRQ
      },
      { method: 'IsAllowed',
        output: { decision: Effect.PERMIT } }
      ]
    );

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
    const hrScopeskey = `cache:${subject.id}:${subject.token}:hrScopes`;
    const subjectKey = `cache:${subject.id}:subject`;
    await redisClient.set(subjectKey, JSON.stringify(acsSubject));
    await redisClient.set(hrScopeskey, JSON.stringify(acsSubject.hierarchical_scopes));

    // store user with tokens and role associations to Redis index `db-findByToken`
    await tokenRedisClient.set('admin-token', JSON.stringify(acsSubject));

    grpcSchedulingSrv = getSchedulingServiceClient(logger);
    const toDelete = (await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {})).total_count;
    const offset = await jobEvents.$offset(-1);

    await grpcSchedulingSrv.delete({ collection: true });

    if (toDelete! > 0) {
      await jobEvents.$wait(offset + toDelete! - 1);
    }

    payloadShouldBeEmpty(await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {}), false);
  });
  beforeEach(async () => {
    for (const event of ['jobsCreated', 'jobsDeleted']) {
      await jobEvents.on(event, () => { });
    }
  });
  afterEach(async () => {
    await Promise.allSettled([
      jobEvents.removeAllListeners('queuedJob'),
      jobEvents.removeAllListeners('jobsCreated'),
      jobEvents.removeAllListeners('jobsDeleted'),
    ]);
  });
  afterAll(async function (): Promise<any> {
    this.timeout(20000);
    await Promise.allSettled([
      stopACSGrpcMockServer(),
      stopIDSGrpcMockServer(),
      jobEvents.removeAllListeners('queuedJob'),
      jobEvents.removeAllListeners('jobsCreated'),
      jobEvents.removeAllListeners('jobsDeleted'),
      await worker.schedulingService.clear(),
    ]);
    await worker.stop();
  });
  describe(`create a one-time job ${testSuffix}`, function postJob(): void {
    this.timeout(30000);
    it(`should create a new job and execute it immediately ${testSuffix}`, async () => {
      const w = await runWorker('test-job', 1, cfg, logger, worker.events, async (job) => {
        validateScheduledJob(job, 'ONCE', logger);

        return {
          result: marshallProtobufAny({
            testValue: 'test-value'
          })
        };
      });

      // validate message emitted on jobDone event.
      await jobEvents.on('jobDone', async (job, context, configRet, eventNameRet) => {
        validateJobDonePayload(job, logger);
      });

      const data = {
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        queue_name: 'test-job',
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
      createResponse!.items!.should.have.length(1);
      createResponse!.items![0]!.payload!.type!.should.equal('test-job');
      createResponse!.items![0]!.status!.code!.should.equal(200);
      createResponse!.items![0]!.status!.message!.should.equal('success');
      createResponse!.operation_status!.code!.should.equal(200);
      createResponse!.operation_status!.message!.should.equal('success');
      // queuedJob (jobDone is emitted from here) - have remvoed jobsDeleted event since we now move the job to completed state
      await jobEvents.$wait(offset + 1);

      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }));
      payloadShouldBeEmpty(result, false);
      createResponse!.operation_status!.code!.should.equal(200);
      createResponse!.operation_status!.message!.should.equal('success');

      await w.pause();
    });

    it(`should create a new job and execute it at a scheduled time ${testSuffix}`, async () => {
      const w = await runWorker('test-job', 1, cfg, logger, worker.events, async (job) => {
        validateScheduledJob(job, 'ONCE', logger);
      });

      const data = {
        timezone: 'Europe/Berlin',
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
        queue_name: 'test-job',
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
      createResponse!.items!.should.have.length(1);
      createResponse!.items![0]!.payload!.type!.should.equal('test-job');
      createResponse!.items![0]!.status!.code!.should.equal(200);
      createResponse!.items![0]!.status!.message!.should.equal('success');
      createResponse!.operation_status!.code!.should.equal(200);
      createResponse!.operation_status!.message!.should.equal('success');

      await jobEvents.$wait(offset + 1); // jobsCreated, queuedJob (jobDone is sent from test)

      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {});
      payloadShouldBeEmpty(result, false);

      await w.pause();
    });

    // temporarily disable as this test tries to use the `default_queue_jobs.ts` file - test 
    // to be migrated to use cjs
    // it(`should create a new job and execute it immediately via external worker ${testSuffix}`, async () => {
    //   let expectedId = '';
    //   await jobEvents.on('jobDone', async (job, context, configRet, eventNameRet) => {
    //     job.id.should.equal(expectedId);
    //   });

    //   const job = {
    //     type: 'external-job',
    //     queue_name: 'default-queue',
    //     data: {
    //       payload: marshallProtobufAny({
    //         testValue: 'test-value'
    //       })
    //     },
    //     options: {
    //       timeout: 1,
    //       priority: JobOptions_Priority.HIGH,
    //       attempts: 1,
    //       backoff: {
    //         type: Backoff_Type.FIXED,
    //         delay: 1000,
    //       }
    //     }
    //   };

    //   const offset = await jobEvents.$offset(-1);
    //   const createResponse = await grpcSchedulingSrv.create({ items: [job], subject }, {});
    //   createResponse.items!.should.have.length(1);
    //   createResponse.items![0]!.payload!.type!.should.equal('external-job');
    //   createResponse.items![0]!.status!.code!.should.equal(200);
    //   createResponse.items![0]!.status!.message!.should.equal('success');
    //   createResponse.operation_status!.code!.should.equal(200);
    //   createResponse.operation_status!.message!.should.equal('success');

    //   expectedId = createResponse.items![0]!.payload!.id!;

    //   // queuedJob (jobDone is emitted from here) - have remvoed jobsDeleted event since we now move the job to completed state
    //   await jobEvents.$wait(offset + 1);

    //   const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }));
    //   payloadShouldBeEmpty(result, false);
    //   createResponse.operation_status!.code!.should.equal(200);
    //   createResponse.operation_status!.message!.should.equal('success');
    // });
  });
  describe(`should create a recurring job ${testSuffix}`, function (): void {
    this.timeout(8000);
    it(`should create a recurring job and delete it after some executions ${testSuffix}`, async () => {
      let jobExecs = 0;
      const w = await runWorker('test-job', 1, cfg, logger, worker.events, async (job) => {
        validateScheduledJob(job, 'RECCUR', logger);

        let result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {});
        should.exist(result!.items);
        result!.items!.length.should.equal(2);
        result!.items![0]!.payload!.type!.should.equal('test-job');
        result!.items![0]!.status!.code!.should.equal(200);
        result!.items![0]!.status!.message!.should.equal('success');
        result!.operation_status!.code!.should.equal(200);
        result!.operation_status!.message!.should.equal('success');

        return {
          delete_scheduled: ++jobExecs === 3
        };
      });

      const data = {
        timezone: 'Europe/Berlin',
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        queue_name: 'test-job',
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
      createdJob.items!.should.have.length(1);
      createdJob.items![0]!.payload!.type!.should.equal('test-job');
      createdJob.items![0]!.status!.code!.should.equal(200);
      createdJob.items![0]!.status!.message!.should.equal('success');
      createdJob.operation_status!.code!.should.equal(200);
      createdJob.operation_status!.message!.should.equal('success');

      // wait for 3 'jobDone'
      await jobEvents.$wait(offset + 3);

      // Sleep for jobDone to get processed
      await new Promise(resolve => setTimeout(resolve, 100));

      await w.pause();
    });
    it('should create a recurring job based on id and remove on completed', async () => {
      const data = {
        timezone: 'Europe/Berlin',
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };
      const job = {
        id: 'test-job-id',
        type: 'test-job',
        queue_name: 'test-job',
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
      createdJob.items!.should.have.length(1);
      createdJob.items![0]!.payload!.type!.should.equal('test-job');
      createdJob.items![0]!.status!.code!.should.equal(200);
      createdJob.items![0]!.status!.message!.should.equal('success');
      createdJob.operation_status!.code!.should.equal(200);
      createdJob.operation_status!.message!.should.equal('success');
    });
    it('should delete a recurring job based on provided id and throw an error on read operation', async () => {
      const deletedJob = await grpcSchedulingSrv.delete(DeleteRequest.fromPartial({
        ids: ['test-job-id'], subject
      }), {});
      deletedJob.status![0]!.id!.should.equal('test-job-id');
      deletedJob.status![0]!.code!.should.equal(200);
      deletedJob.status![0]!.message!.should.equal('success');
      deletedJob.operation_status!.code!.should.equal(200);
      deletedJob.operation_status!.message!.should.equal('success');
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ filter: { job_ids: ['test-job-id'] }, subject }), {});
      result!.items![0]!.status!.id!.should.equal('test-job-id');
      result!.items![0]!.status!.code!.should.equal(404);
      result!.items![0]!.status!.message!.should.equal('Job ID test-job-id not found in any of the queues');
      result!.operation_status!.code!.should.equal(200);
      result!.operation_status!.message!.should.equal('success');
    });
  });
  describe(`managing jobs ${testSuffix}`, function (): void {
    this.timeout(10000);
    it('should schedule some jobs for tomorrow', async () => {
      const data = {
        timezone: 'Europe/Berlin',
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      // schedule the job to be executed tomorrow
      // we can specify any Date instance for scheduling the job
      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 1);

      const jobs = new Array<Job>;
      for (let i = 0; i < 4; i += 1) {
        jobs[i] = {
          type: 'test-job',
          queue_name: 'test-job',
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
      createResponse.items!.should.have.length(4);
      createResponse.items![0]!.payload!.type!.should.equal('test-job');
      createResponse.items![0]!.status!.code!.should.equal(200);
      createResponse.items![0]!.status!.message!.should.equal('success');
      createResponse.operation_status!.code!.should.equal(200);
      createResponse.operation_status!.message!.should.equal('success');
    });
    it(`should retrieve all job properties correctly with empty filter ${testSuffix}`, async () => {
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ sort: JobReadRequest_SortOrder.DESCENDING, subject }), {});
      should.exist(result);
      should.exist(result!.items);
      result!.items!.should.be.length(5);
      result!.items!.forEach((job) => {
        validateJob(job.payload, logger);
        job.status!.code!.should.equal(200);
        job.status!.message!.should.equal('success');
      });
      result!.operation_status!.code!.should.equal(200);
      result!.operation_status!.message!.should.equal('success');
    });
    it(`should retrieve all job properties correctly with filter type or id ${testSuffix}`, async () => {
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ filter: { type: 'test-job' }, sort: JobReadRequest_SortOrder.ASCENDING, subject }), {});
      should.exist(result);
      should.exist(result!.items);
      result!.items!.should.be.length(5);
      result!.items!.forEach((job) => {
        validateJob(job.payload, logger);
        job.status!.code!.should.equal(200);
        job.status!.message!.should.equal('success');
      });
      result!.operation_status!.code!.should.equal(200);
      result!.operation_status!.message!.should.equal('success');

      const result_id_type = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({
        filter: { type: 'test-job', job_ids: [result!.items![0]!.payload!.id!] },
        subject
      }), {});
      should.exist(result_id_type);
      should.exist(result_id_type.items);
      result_id_type.items!.should.be.length(1);
      result_id_type.items!.forEach((job) => {
        validateJob(job.payload, logger);
        job.status!.code!.should.equal(200);
        job.status!.message!.should.equal('success');
      });
      result_id_type.operation_status!.code!.should.equal(200);
      result_id_type.operation_status!.message!.should.equal('success');

      const result_id = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({
        filter: { job_ids: [result!.items![0]!.payload!.id!] },
        subject
      }), {});
      should.exist(result_id);
      should.exist(result_id.items);
      result_id.items!.should.be.length(1);
      result_id.items!.forEach((job) => {
        validateJob(job.payload, logger);
        job.status!.code!.should.equal(200);
        job.status!.message!.should.equal('success');
      });
    });
    it(`should update / reschedule a job ${testSuffix}`, async () => {
      let result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {});
      const job = result!.items![0]!.payload;

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job!.when = scheduledTime.toISOString();

      const offset = await jobEvents.$offset(-1);
      result = await grpcSchedulingSrv.update({
        items: [job!], subject
      });

      should.exist(result);
      should.exist(result!.items);
      result!.items!.should.have.length(1);

      const updatedJob = result!.items![0]!;
      validateJob(updatedJob.payload, logger);
      updatedJob.status!.code!.should.equal(200);
      updatedJob.status!.message!.should.equal('success');
      result!.operation_status!.code!.should.equal(200);
      result!.operation_status!.message!.should.equal('success');
      // waiting for event creation
      await jobEvents.$wait(offset + 1);
    });
    it(`should upsert a job ${testSuffix}`, async () => {
      let result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {});
      const job = result!.items![0]!.payload;

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 3); // three days from now
      job!.when = scheduledTime.toISOString();

      const offset = await jobEvents.$offset(-1);
      result = await grpcSchedulingSrv.upsert({
        items: [job!], subject
      });
      should.exist(result);
      should.exist(result!.items);
      result!.items!.should.have.length(1);

      const upsertedJob = result!.items![0];
      validateJob(upsertedJob.payload, logger);
      upsertedJob!.status!.code!.should.equal(200);
      upsertedJob!.status!.message!.should.equal('success');
      result!.operation_status!.code!.should.equal(200);
      result!.operation_status!.message!.should.equal('success');
      // waiting for event creation
      await jobEvents.$wait(offset + 1);
    });
    // -ve test cases to be run when ACS is enabled
    // set subject target scope to invlaid scope not present in subject's HR scope
    if (acsEnabled) {
      const data = {
        timezone: 'Europe/Berlin',
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
        result!.operation_status!.code!.should.equal(403);
        result!.operation_status!.message!.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:CREATE, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error retreiving job properties with empty filter with invalid scope ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ sort: JobReadRequest_SortOrder.DESCENDING, subject }), {});
        result!.operation_status!.code!.should.equal(403);
        result!.operation_status!.message!.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:READ, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error when updating / rescheduling a job with invalid scope ${testSuffix}`, async () => {
        const scheduledTime = new Date();
        scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
        (job as any).when = scheduledTime.toISOString();
        const result = await grpcSchedulingSrv.update(JobList.fromPartial({
          items: [job], subject
        }));
        result!.operation_status!.code!.should.equal(403);
        result!.operation_status!.message!.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:MODIFY, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error when upserting a job with invalid scope ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.upsert(JobList.fromPartial({
          items: [job], subject
        }));
        result!.operation_status!.code!.should.equal(403);
        result!.operation_status!.message!.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:MODIFY, target_scope:orgD; the response was DENY');
      });
      it(`should throw an error deleting jobs ${testSuffix}`, async () => {
        const result = await grpcSchedulingSrv.delete({
          collection: true, subject
        }, {});
        result!.operation_status!.code!.should.equal(403);
        result!.operation_status!.message!.should.equal('Access not allowed for request with subject:admin_user_id, resource:job, action:DROP, target_scope:orgD; the response was DENY');
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
      const result = await grpcSchedulingSrv.read(JobReadRequest.fromPartial({ subject }), {});
      payloadShouldBeEmpty(result, false);
      result!.operation_status!.code!.should.equal(200);
      result!.operation_status!.message!.should.equal('success');
    });
  });
});
