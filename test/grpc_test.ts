import * as mocha from 'mocha';
import * as should from 'should';
import { marshallProtobufAny } from '../lib/schedulingService';
import { Worker } from '../lib/worker';
import { Topic } from '@restorecommerce/kafka-client';
import * as sconfig from '@restorecommerce/service-config';
import { Client } from '@restorecommerce/grpc-client';
import { Logger } from '@restorecommerce/logger';
import {
  validateJobResource, shouldBeEmpty, validateScheduledJob
} from './utils';
import { Backoffs, Priority, SortOrder, NewJob } from "../lib/types";

/**
 * NOTE: Running instances of Redis and Kafka are required to run the tests.
 */

const QUEUED_JOBS_TOPIC = 'io.restorecommerce.jobs';
const JOB_RESOURCE_TOPIC = 'io.restorecommerce.jobs.resource';

describe('testing scheduling-srv: gRPC', () => {
  let worker: Worker;
  let jobEvents: Topic;
  let jobResourceEvents: Topic;
  let serviceClient: Client;
  let grpcSchedulingSrv: any;

  before(async function (): Promise<any> {
    this.timeout(4000);
    worker = new Worker();

    const cfg = sconfig(process.cwd() + '/test');
    await worker.start(cfg);

    jobEvents = worker.events.topic(QUEUED_JOBS_TOPIC);
    jobResourceEvents = worker.events.topic(JOB_RESOURCE_TOPIC);

    const logger = new Logger(cfg.get('logger'));
    serviceClient = new Client(cfg.get('client:schedulingClient'), logger);
    grpcSchedulingSrv = await serviceClient.connect();

    const toDelete = (await grpcSchedulingSrv.read({}, {})).total_count;
    const jobResourceOffset = await jobResourceEvents.$offset(-1);

    await grpcSchedulingSrv.delete({ collection: true });

    if (toDelete > 0) {
      await jobResourceEvents.$wait(jobResourceOffset + toDelete - 1);
    }

    shouldBeEmpty(await grpcSchedulingSrv.read({}, {}));
  });
  beforeEach(async () => {
    for (let event of ['jobsCreated', 'jobsDeleted']) {
      await jobResourceEvents.on(event, () => { });
    }
  });
  afterEach(async () => {
    await jobEvents.removeAllListeners('queuedJob');
    await jobResourceEvents.removeAllListeners('jobsCreated');
    await jobResourceEvents.removeAllListeners('jobsDeleted');
  });
  after(async () => {
    await jobEvents.removeAllListeners('queuedJob');
    await jobResourceEvents.removeAllListeners('jobsCreated');
    await jobResourceEvents.removeAllListeners('jobsDeleted');
    await worker.schedulingService.clear();
    await worker.stop();
    await serviceClient.end();
  });
  describe('create a one-time job', function postJob(): void {
    this.timeout(8000);
    it('should create a new job and execute it immediately', async () => {
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'NOW');

        const { id, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, schedule_type });
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
          timeout: 1,
          priority: Priority.HIGH,
          attempts: 1,
          backoff: {
            type: Backoffs.FIXED,
            delay: 1000,
          }
        }
      } as NewJob;

      const offset = await jobEvents.$offset(-1);
      await grpcSchedulingSrv.create({ items: [job], }, {});

      await jobEvents.$wait(offset); // queued, jobDone

      await jobEvents.$wait(offset + 1); // queued, jobDone

      // Simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = await grpcSchedulingSrv.read({});
      shouldBeEmpty(result);
    });

    it('should create a new job and execute it at a scheduled time', async () => {
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'ONCE');

        const { id, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, schedule_type });
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
          priority: Priority.HIGH,
          attempts: 1,
          backoff: {
            delay: 1000,
            type: Backoffs.FIXED,
          },
        }
      } as NewJob;

      const offset = await jobEvents.$offset(-1);
      const jobResourceOffset = await jobResourceEvents.$offset(-1);

      await grpcSchedulingSrv.create({
        items: [job],
      }, {});

      await jobResourceEvents.$wait(jobResourceOffset + 1);
      await jobEvents.$wait(offset + 1);

      const result = await grpcSchedulingSrv.read({}, {});
      shouldBeEmpty(result);
    });
  });
  describe('creating a recurring job', function (): void {
    this.timeout(8000);
    it('should create a recurring job and delete it after some executions', async () => {
      let jobExecs = 0;
      await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        validateScheduledJob(job, 'RECCUR');

        const { id, schedule_type } = job;
        await jobEvents.emit('jobDone', { id, schedule_type, delete_scheduled: ++jobExecs === 3 });

        // Sleep for jobDone to get processed
        await new Promise(resolve => setTimeout(resolve, 100));

        let result = await grpcSchedulingSrv.read({}, {});
        should.exist(result);

        if (jobExecs == 3) {
          shouldBeEmpty(result);
        } else {
          result.data.total_count.should.be.equal(1);
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

      const jobOffset = await jobEvents.$offset(-1);
      const jobResourceOffset = await jobResourceEvents.$offset(-1);

      const createdJob = await grpcSchedulingSrv.create({
        items: [job],
      }, {});

      should.exist(createdJob);
      should.exist(createdJob.data);
      should.exist(createdJob.data.items);
      createdJob.data.items.should.have.length(1);

      // wait for 3 'queuedJob' and 3 'jobDone' events
      await jobEvents.$wait(jobOffset + 5);
      // wait for 'jobsCreated' and 'jobsDeleted' events
      await jobResourceEvents.$wait(jobResourceOffset + 1);

      // Sleep for jobDone to get processed
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  });
  describe('managing jobs', function (): void {
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
            priority: Priority.HIGH,
            attempts: 1,
            backoff: {
              delay: 1000,
              type: Backoffs.FIXED,
            }
          }
        } as NewJob;
      }

      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      const newVar = await grpcSchedulingSrv.create({
        items: jobs,
      }, {});

      await jobResourceEvents.$wait(jobResourceOffset + 3);
    });
    it('should retrieve all job properties correctly with empty filter', async () => {
      const result = await grpcSchedulingSrv.read({ sort: SortOrder.DESCENDING }, {});
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.be.length(4);
      result.data.items.forEach((job) => {
        validateJobResource(job);
      });
    });
    it('should retrieve all job properties correctly with filter type or id', async () => {
      const result = await grpcSchedulingSrv.read({ filter: { type: 'test-job' }, sort: 'ASCENDING' }, {});
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.be.length(4);
      result.data.items.forEach((job) => {
        validateJobResource(job);
      });

      const result_id_type = await grpcSchedulingSrv.read({
        filter: { type: 'test-job', job_ids: result.data.items[0].id }
      }, {});
      should.exist(result_id_type);
      should.exist(result_id_type.data);
      should.exist(result_id_type.data.items);
      result_id_type.data.items.should.be.length(1);
      result_id_type.data.items.forEach((job) => {
        validateJobResource(job);
      });

      const result_id = await grpcSchedulingSrv.read({
        filter: { job_ids: result.data.items[0].id }
      }, {});
      should.exist(result_id);
      should.exist(result_id.data);
      should.exist(result_id.data.items);
      result_id.data.items.should.be.length(1);
      result_id.data.items.forEach((job) => {
        validateJobResource(job);
      });
    });
    it('should update / reschedule a job', async () => {
      let result = await grpcSchedulingSrv.read({}, {});
      const job = result.data.items[0];

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 2); // two days from now
      job.when = scheduledTime.toISOString();

      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      result = await grpcSchedulingSrv.update({
        items: [job]
      });

      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.have.length(1);

      const updatedJob = result.data.items[0];
      validateJobResource(updatedJob);
      // waiting for event creation
      await jobResourceEvents.$wait(jobResourceOffset + 1);
    });
    it('should upsert a job', async () => {
      let result = await grpcSchedulingSrv.read({}, {});
      const job = result.data.items[0];

      const scheduledTime = new Date();
      scheduledTime.setDate(scheduledTime.getDate() + 3); // three days from now
      job.when = scheduledTime.toISOString();

      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      result = await grpcSchedulingSrv.upsert({
        items: [job]
      });
      should.exist(result);
      should.exist(result.data);
      should.exist(result.data.items);
      result.data.items.should.have.length(1);

      const upsertedJob = result.data.items[0];
      validateJobResource(upsertedJob);
      // waiting for event creation
      await jobResourceEvents.$wait(jobResourceOffset + 1);
    });
    it('should delete all remaining scheduled jobs upon request', async () => {
      const jobResourceOffset = await jobResourceEvents.$offset(-1);
      await grpcSchedulingSrv.delete({
        collection: true
      }, {});
      const result = await grpcSchedulingSrv.read({}, {});
      shouldBeEmpty(result);
      await jobResourceEvents.$wait(jobResourceOffset + 3);
    });
  });
});
