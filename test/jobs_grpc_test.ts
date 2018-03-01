'use strict';

import * as mocha from 'mocha';
import * as should from 'should';
import { Worker } from '../worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

import { Client } from '@restorecommerce/grpc-client';
import * as Logger from '@restorecommerce/logger';

import { marshallPayload, unmarshallPayload } from './utils';
/* global describe it beforeEach afterEach */
/**
 * NOTE: A running redis, kafka and ArangoDB instance is required to run below test.
 */

const QUEUED_TOPIC_NAME = 'io.restorecommerce.jobs';

const Priority = {
  NORMAL: 0,
  LOW: 10,
  MEDIUM: -5,
  HIGH: -10,
  CRITICAL: -15,
};

const Backoffs = {
  FIXED: 'FIXED',
  EXPONENTIAL: 'EXPONENTIAL',
};
let jobInstID;
describe('Worker', () => {
  let worker: Worker;
  let jobEvents: Topic;
  let serviceClient: Client;
  let grpcSchedulingSrv: any;
  before(async () => {
    worker = new Worker();
    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);
    jobEvents = worker.events.topic(QUEUED_TOPIC_NAME);

    const logger = new Logger(cfg.get('logger'));
    serviceClient = new Client(cfg.get('client:schedulingClient'), logger);
    grpcSchedulingSrv = await serviceClient.connect();
  });
  after(async () => {
    await worker.stop();
    await serviceClient.end();
  });
  describe('post a new job via gRPC', function postJob(): void {
    this.timeout(5000);
    it('should create a new job and execute it immediately', async () => {
      const jobID = 'grpc-test';
      let err;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        if (job.name === jobID) {
          try {
            validate(jobID, job);
            await jobEvents.emit('jobDone', { id: job.id });
          } catch (error) {
            err = error;
          }
        }
      });
      const data = {
        timezone: "Europe/Berlin",
        payload: marshallPayload({
          testValue: 'test-value'
        })
      };

      const job = {
        id: `/jobs/${jobID}`,
        name: jobID,
        data,
        priority: Priority.HIGH,
        attempts: 1,
        backoff: {
          delay: 1000,
          type: Backoffs.FIXED,
        },
        now: true
      };

      const offset = await jobEvents.$offset(-1);
      await grpcSchedulingSrv.create({ items: [job], }, {});
      await jobEvents.$wait(offset + 1);
      should.not.exist(err);

      const result = await grpcSchedulingSrv.read({}, {});
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      // there should not be any data since we do not store the jobs in DB
      // which are to be executed immediately
      result.data.items.should.be.length(0);
    });
    it('should create a new job and execute it at a scheduled time', async () => {
      const jobID = 'grpc-test-scheduled';
      let err;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        if (job.name === jobID) {
          try {
            validate(jobID, job);
            await jobEvents.emit('jobDone', { id: job.id });
          } catch (error) {
            err = error;
          }
        }
      });

      const data = {
        timezone: "Europe/Berlin",
        payload:
        marshallPayload({
          testValue: 'test-value'
        })
      };

      // schedule the job to be executed 4 seconds from now.
      // we can specify any Date instance for scheduling the job
      let scheduledTime = new Date();
      scheduledTime.setSeconds(scheduledTime.getSeconds() + 4);
      const job = {
        id: `/jobs/${jobID}`,
        name: jobID,
        data,
        priority: Priority.HIGH,
        attempts: 1,
        backoff: {
          delay: 1000,
          type: Backoffs.FIXED,
        },
        when: scheduledTime.toISOString()
      };

      const offset = await jobEvents.$offset(-1);
      await grpcSchedulingSrv.create({
        items: [job],
      }, {});
      if (err) {
        throw err;
      }
      await jobEvents.$wait(offset + 1);

      // const result = await grpcSchedulingSrv.read({}, {});
      // result.items.should.be.length(1);
    });
  });
  describe('delete job via gRPC', function deleteJob(): void {
    this.timeout(5000);
    it('should delete the created job', async () => {
      // Delete the above posted job itself
      const jobID = 'grpc-test-scheduled';
      let err;
      const job = {
        id: `/jobs/${jobID}`
      };
      await grpcSchedulingSrv.delete({
        ids: [job.id],
        id: jobInstID
      }, {});
      setTimeout(async function (): Promise<any> {
        const result = await grpcSchedulingSrv.read({}, {});
        should.exist(result);
        should.exist(result.items);
        result.items.should.be.length(0);
      }, 1000);
      if (err) {
        throw err;
      }
    });
  });
});

function validate(jobID: string, job: any): any {
  should.exist(job.data);
  should.exist(job.data.payload);
  const payload = unmarshallPayload(job.data.payload);
  should.exist(payload.testValue);
  payload.testValue.should.equal('test-value');
  job.name.should.equal(jobID);
}
