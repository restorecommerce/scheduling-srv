import * as _ from 'lodash';
import * as mocha from 'mocha';
import * as should from 'should';

import {
  Priority, Backoffs, SchedulingService,
  marshallProtobufAny, unmarshallProtobufAny
} from '../schedulingService';
import { Worker } from '../worker';

import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import * as Logger from '@restorecommerce/logger';

import {
  validateJobResource,
  shouldBeEmpty, validateScheduledJob
} from './utils';

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
  before(async () => {
    worker = new Worker();

    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);

    schedulingService = worker.schedulingService;

    jobTopic = worker.events.topic(QUEUED_JOBS_TOPIC);
    jobResourceTopic = worker.events.topic(JOB_RESOURCE_TOPIC);
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
    await worker.schedulingService.clear();
    await worker.stop();
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
        timezone: "Europe/Berlin",
        creator: 'test-creator',
        payload: marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        data,
        priority: Priority.HIGH,
        attempts: 1,
        backoff: {
          delay: 1000,
          type: Backoffs.FIXED,
        },
        now: true
      };

      const offset = await jobTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: [job] });
      const result = await schedulingService.read({
        request: {}
      });
      shouldBeEmpty(result);

      await jobTopic.$wait(offset + 2); // createJobs, queued, jobDone
    });
    it('should create a new job and execute it at a scheduled time', async () => {
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, schedule_type });
      });

      const data = {
        timezone: "Europe/Berlin",
        creator: 'test-creator',
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
        priority: Priority.HIGH,
        attempts: 1,
        backoff: {
          delay: 1000,
          type: Backoffs.FIXED,
        },
        when: scheduledTime.toISOString()
      };
      const offset = await jobTopic.$offset(-1);
      const jobResourceOffset = await jobResourceTopic.$offset(-1);

      await jobTopic.emit('createJobs', { items: [job] });
      const result = await schedulingService.read({
        request: {}
      });
      shouldBeEmpty(result);

      await jobTopic.$wait(offset + 2);
      await jobResourceTopic.$wait(jobResourceOffset + 1);
    });
  });
  describe('creating a recurring job', function (): void {
    this.timeout(15000);
    it('should create a recurring job and delete it after some executions', async () => {
      let jobExecs = 0;
      let jobID;
      await jobTopic.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'RECCUR');

        const { id, schedule_type } = job;
        await jobTopic.emit('jobDone', { id, schedule_type });

        let result = await schedulingService.read({ request: {} }, {});
        should.not.exist(result.error);
        should.exist(result);
        should.exist(result);
        should.exist(result.items);

        result.items.should.have.length(1);

        jobExecs += 1;
        if (jobExecs == 3) {
          await jobTopic.emit('deleteJobs', {
            ids: [jobID]
          });

          result = await schedulingService.read({}, {});
          shouldBeEmpty(result);
        }
      });

      const data = {
        timezone: "Europe/Berlin",
        creator: 'test-creator',
        payload:
        marshallProtobufAny({
          testValue: 'test-value'
        })
      };

      const job = {
        type: 'test-job',
        data,
        priority: Priority.HIGH,
        attempts: 1,
        backoff: {
          delay: 1000,
          type: Backoffs.FIXED,
        },
        interval: '2 seconds'
      };

      const jobOffset = await jobTopic.$offset(-1);
      const jobResourceOffset = await jobResourceTopic.$offset(-1);

      await jobTopic.emit('createJobs', { items: [job] });

      // wait for 'jobsCreated'
      await jobResourceTopic.$wait(jobResourceOffset);

      const created = await schedulingService.read({}, {});
      should.exist(created);
      should.exist(created.items);
      jobID = created.items[0].id;

      // wait for 3 'queuedJob', 3 'jobDone', 1 'createJobs', 1 'deleteJobs'
      await jobTopic.$wait(jobOffset + 7);

      // wait for jobsDeleted'
      await jobResourceTopic.$wait(jobResourceOffset + 1);
    });
  });
  describe('managing jobs', function (): void {
    this.timeout(15000);
    it('should schedule some jobs for tomorrow', async () => {
      const data = {
        timezone: "Europe/Berlin",
        creator: 'test-creator',
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
          priority: Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoffs.FIXED,
          },
          when: scheduledTime.toISOString()
        };
      }

      const jobResourceOffset = await jobResourceTopic.$offset(-1);
      await jobTopic.emit('createJobs', { items: jobs });

      await jobResourceTopic.$wait(jobResourceOffset + 3);
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
