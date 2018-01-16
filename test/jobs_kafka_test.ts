'use strict';

import * as mocha from 'mocha';
import * as coMocha from 'co-mocha';
coMocha(mocha);
import * as should from 'should';
import { Worker } from '../worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

/* global describe it beforeEach afterEach */

const QUEUED_TOPIC_NAME = 'io.restorecommerce.jobs';
const JOBS_RESOURCE_TOPIC = 'io.restorecommerce.jobs.resource';

const Priority = {
  NORMAL: 0,
  LOW: 10,
  MEDIUM: -5,
  HIGH: -10,
  CRITICAL: -15,
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
  describe('post new job via Kafka', function postNewJob(): any {
    this.timeout(6000);
    it('should create a new job', async () => {
      const jobID = 'kafka-test';
      let err;
      await jobEvents.on('queuedJob', (job, context, configRet, eventNameRet) => {
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

      const offset = await jobEvents.$offset(-1) + 1;
      await jobEvents.emit('createJobs', { items: [job] });
      if (err) {
        throw err;
      }
      await jobEvents.$wait(offset);

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
      const jobResourceTopic = worker.events.topic(JOBS_RESOURCE_TOPIC);
      const offset = await jobResourceTopic.$offset(-1);
      await jobEvents.emit('deleteJobs', { ids: [job.id] });

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
