import * as _ from 'lodash';
import * as mocha from 'mocha';
import * as should from 'should';

import { SchedulingService, marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';

import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';

import {
  validateJobResource,
  shouldBeEmpty, validateScheduledJob
} from './utils';
import { Backoffs, NewJob, Priority } from "../lib/types";

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */


const QUEUED_JOBS_TOPIC = 'io.restorecommerce.jobs';
const JOB_RESOURCE_TOPIC = 'io.restorecommerce.jobs.resource';

let jobInstID;

describe('testing scheduling-srv: Kafka', () => {
  let worker: Worker;
  let jobTopic: Topic;
  let jobResourceTopic: Topic;
  let schedulingService: SchedulingService;
  before(async function (): Promise<any> {
    this.timeout(4000);
    worker = new Worker();

    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);

    schedulingService = worker.schedulingService;

    jobTopic = worker.events.topic(QUEUED_JOBS_TOPIC);
    jobResourceTopic = worker.events.topic(JOB_RESOURCE_TOPIC);

    const toDelete = (await schedulingService.read({}, {})).total_count;
    const jobResourceOffset = await jobResourceTopic.$offset(-1);

    await jobTopic.emit('deleteJobs', { collection: true });

    if (toDelete > 0) {
      await jobResourceTopic.$wait(jobResourceOffset + toDelete - 1);
    }

    shouldBeEmpty(await schedulingService.read({}, {}));
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
        validateScheduledJob(job, 'NOW');

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
      await jobTopic.emit('createJobs', { items: [job] });

      await jobTopic.$wait(offset + 2); // createJobs, queued, jobDone

      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await schedulingService.read({ request: {} });
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

      await jobTopic.emit('createJobs', { items: [job] });

      await jobResourceTopic.$wait(jobResourceOffset);

      let result = await schedulingService.read({
        request: {}
      });
      result.items.should.have.length(1);

      await jobTopic.$wait(offset + 2);
      await jobResourceTopic.$wait(jobResourceOffset + 1);

      result = await schedulingService.read({
        request: {}
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

        let result = await schedulingService.read({ request: {} }, {});
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

      await jobTopic.emit('createJobs', { items: [job] });

      // wait for 'jobsCreated'
      await jobResourceTopic.$wait(jobResourceOffset);

      const created = await schedulingService.read({}, {});
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
      await jobTopic.emit('createJobs', { items: jobs });

      await jobResourceTopic.$wait(jobResourceOffset + 3);

      let result = await schedulingService.read({ request: {} }, {});
      result.total_count.should.be.equal(4);
    });
    it('should update / reschedule a job', async () => {
      let result = await schedulingService.read({ request: {} }, {});
      const job = result.items[0];

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job.when = scheduledTime.toISOString();

      const jobResourceOffset = await jobResourceTopic.$offset(-1);
      await jobTopic.emit('modifyJobs', {
        items: [job]
      });
      await jobResourceTopic.$wait(jobResourceOffset + 1);

      result = await schedulingService.read({ request: {} }, {});
      should.exist(result);
      should.exist(result.items);
      result.items = _.sortBy(result.items, ['id']);
      const updatedJob = _.last(result.items);
      validateJobResource(updatedJob);
      // waiting for event creation
    });
    it('should delete all remaining scheduled jobs upon request', async () => {

      await jobTopic.emit('deleteJobs', { collection: true });

      const jobResourceOffset = await jobResourceTopic.$offset(-1);
      await jobResourceTopic.$wait(jobResourceOffset + 3);
      const result = await schedulingService.read({}, {});
      shouldBeEmpty(result);
    });
  });
});
