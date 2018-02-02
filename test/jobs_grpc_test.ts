'use strict';

import * as mocha from 'mocha';
import * as should from 'should';
import { Worker } from '../worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

/* global describe it beforeEach afterEach */

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
    it('should create a new job', async () => {
      const jobID = 'grpc-test';
      let err;
      await jobEvents.on('queuedJob', (job, context, configRet, eventNameRet) => {
        if (job.name === jobID) {
          try {
            should.exist(job.data);
            job.data.payload[0].value.toString().should.equal('test Value');
            job.name.should.equal(jobID);
            return;
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
      // Example Value for Data is: data: {timezone: "Europe/Amsterdam",
      // payload: [{ type_url: "A test", value: "B test"}]},
      const data = {
        timezone: "Europe/Amsterdam",
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
        interval: '',
        when: new Date()
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
      await jobEvents.$wait(offset);

      // await jobEvents.$wait(offset);
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
      const jobID = 'grpc-test';
      let err;
      const job = {
        id: `/jobs/${jobID}`
      };
      await worker.jobResourceService.delete({
        request: {
          ids: [job.id],
        },
      }, {});
      setTimeout(async function (): Promise<any> {
        const result = await worker.jobResourceService.read({
          request: {},
        }, {});
        result.items.should.be.length(0);
      }, 1000);
      // const result = await worker.jobResourceService.read({
      //   request: {},
      // }, {});
      // result.items.should.be.length(0);
      if (err) {
        throw err;
      }
    });
  });
});
