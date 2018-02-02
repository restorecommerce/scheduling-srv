'use strict';

import * as mocha from 'mocha';
import * as should from 'should';
import { Worker } from '../worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

/* global describe it beforeEach afterEach */

const Priority = {
  NORMAL: 0,
  LOW: 10,
  MEDIUM: -5,
  HIGH: -10,
  CRITICAL: -15,
};

describe('Worker', () => {
  let worker: Worker;
  let jobTopic: Topic;
  let jobResourceTopic: Topic;
  before(async () => {
    worker = new Worker();
    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);

    jobTopic = worker.events.topic(cfg.get('events:kafka:topics:jobs:topic'));
    jobResourceTopic = worker.events.topic(cfg.get('events:kafka:topics:jobs.resource:topic'));
  });
  after(async () => {
    await worker.stop();
  });
  describe('post new job via Kafka', function postNewJob(): any {
    this.timeout(6000);
    it('should create a new job', async () => {
      const jobID = 'kafka-test';
      let err;
      await jobTopic.on('queuedJob', (job, context, configRet, eventNameRet) => {
        if (job.name === jobID) {
          try {
            should.exist(job.payload);
            job.name.should.equal(jobID);
            return;
          } catch (error) {
            err = error;
          }
        }
      });
      const string2Dec = (str) => {
        return str.split('').map((val) => {
          return val.charCodeAt(0);
        });
      };
      const data = {
        timezone: "Europe/Amsterdam",
        payload: [{ type_url: "A test", value: string2Dec('A test Value') }]
      };
      const job = {
        id: `/jobs/${jobID}`,
        name: jobID,
        data,
        priority: Priority.HIGH,
        attempts: 1,
        interval: '',
        when: new Date()
      };

      const offset = await jobTopic.$offset(-1) + 1;
      await jobTopic.emit('createJobs', { items: [job] });
      if (err) {
        throw err;
      }
      await jobTopic.$wait(offset);

      // await jobEvents.$wait(offset);
      const result = await worker.jobResourceService.read({
        request: {},
      }, {});
      result.items[0].id.should.equal('/jobs/kafka-test');
    });
  });
  describe('delete job via Kafka', function deleteJob(): any {
    this.timeout(7000);
    it('should delete the created job', async () => {
      // Delete the above posted job itself
      const jobID = 'kafka-test';
      let err;
      const job = {
        id: `/jobs/${jobID}`
      };

      const offset = await jobResourceTopic.$offset(-1);
      await jobTopic.emit('deleteJobs', { ids: [job.id] });

      // Create a listener for Jobs resource topic to check if the job
      // was actually deleted
      await jobResourceTopic.on('jobsDeleted', async function
        onDeletedEvent(message: any, context: any): Promise<any> {
        should.exist(message);
        // Read the DB again and there should be no data.
        const result = await worker.jobResourceService.read({
          request: {},
        }, {});
        result.items.should.be.length(0);
        if (err) {
          throw err;
        }
      });
      await jobResourceTopic.$wait(offset);
    });
  });
});
