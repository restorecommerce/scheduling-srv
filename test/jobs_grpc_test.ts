'use strict';

import * as mocha from 'mocha';
import * as should from 'should';
import { Worker } from '../worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

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
  before(async () => {
    worker = new Worker();
    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);
    jobEvents = worker.events.topic(QUEUED_TOPIC_NAME);
  });
  after(async () => {
    await worker.stop();
  });
  describe('post new job via gRPC', function postNewJob() {
    this.timeout(5000);
    it('should create a new job and execute it immediately', async () => {
      const jobID = 'grpc-test';
      let err;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        jobInstID = job.id;
        if (job.name === jobID) {
          try {
            should.exist(job.data);
            job.data.payload[0].value.toString().should.equal('test Value');
            job.name.should.equal(jobID);
            await jobEvents.emit('jobDone', { id: job.id });
          } catch (error) {
            err = error;
          }
        }
      });
      const string2Dec = (str) => {
        const converted = str.split('').map((val) => {
          return val.charCodeAt(0);
        });
        return converted;
      };
      const data = {
        timezone: "Europe/Berlin",
        payload: [{ type_url: "test key", value: string2Dec('test Value') }]
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
      await worker.jobResourceService.create({
        request: {
          items: [job],
        },
      }, {});
      if (err) {
        throw err;
      }
      await jobEvents.$wait(offset + 1);

      const result = await worker.jobResourceService.read({
        request: {},
      }, {});
      // there should not be any data since we do not store the jobs in DB
      // which are to be executed immediately
      result.items.should.be.length(0);
    });
    it('should create a new job and execute it at scheduled time', async () => {
      const jobID = 'grpc-test-scheduled';
      let err;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        jobInstID = job.id;
        if (job.name === jobID) {
          try {
            should.exist(job.data);
            job.data.payload[0].value.toString().should.equal('test another Value');
            job.name.should.equal(jobID);
            await jobEvents.emit('jobDone', { id: job.id });
          } catch (error) {
            err = error;
          }
        }
      });
      const string2Dec = (str) => {
        const converted = str.split('').map((val) => {
          return val.charCodeAt(0);
        });
        return converted;
      };
      const data = {
        timezone: "Europe/Berlin",
        payload: [{ type_url: "test key", value: string2Dec('test another Value') }]
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
      await worker.jobResourceService.create({
        request: {
          items: [job],
        },
      }, {});
      if (err) {
        throw err;
      }
      await jobEvents.$wait(offset + 1);

      const result = await worker.jobResourceService.read({
        request: {},
      }, {});
      result.items.should.be.length(1);
    });
  });
  describe('delete job via gRPC', function deleteJob() {
    this.timeout(5000);
    it('should delete the created job', async () => {
      // Delete the above posted job itself
      const jobID = 'grpc-test-scheduled';
      let err;
      const job = {
        id: `/jobs/${jobID}`
      };
      await worker.jobResourceService.delete({
        request: {
          ids: [job.id],
          id: jobInstID
        },
      }, {});
      setTimeout(async function (): Promise<any> {
        const result = await worker.jobResourceService.read({
          request: {},
        }, {});
        result.items.should.be.length(0);
      }, 1000);
      if (err) {
        throw err;
      }
    });
  });
});
