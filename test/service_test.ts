'use strict';

import * as mocha from 'mocha';
import * as coMocha from 'co-mocha';
coMocha(mocha);
import * as should from 'should';
import * as _ from 'lodash';
import { SchedulingService } from '../schedulingService';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as chassis from '@restorecommerce/chassis-srv';
import * as sconfig from '@restorecommerce/service-config';
const Logger = chassis.Logger;

/* global describe it beforeEach afterEach */

const JOBS_TOPIC_NAME = 'io.restorecommerce.jobs';

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

const string2Dec = (str) => {
  const converted = str.split('').map((val) => {
    return val.charCodeAt(0);
  });
  return converted;
};
const data = {
  timezone: "Europe/Amsterdam",
  payload: [{ type_url: "test key", value: string2Dec('test Value') }]
};

describe('SchedulingService', () => {
  let service: SchedulingService;
  let events: Events;
  let jobEvents: Topic;
  before(async () => {
    // yield chassis.config.load(process.cwd() + '/test', { verbose: () => { } });
    const config = sconfig(process.cwd() + '/test');
    const log = new Logger(config.get('logger'));
    const redisConfig = config.get('cache:kue-scheduler:0');
    events = new Events(config.get('events:kafka'), log);
    await events.start();
    jobEvents = events.topic(JOBS_TOPIC_NAME);
    service = new SchedulingService(jobEvents, redisConfig, config, log);
    await service.start([]);
  });
  after(async () => {
    await events.stop();
    await service.stop();
  });
  describe('createJob', () => {
    describe('called once with interval now', () => {
      it('should allow scheduling one job which runs immediately', async () => {
        let err;
        await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
          try {
            should.exist(job.data);
            job.data.payload[0].value.toString().should.equal('test Value');
            await jobEvents.emit('jobDone', { id: job.id });
          } catch (error) {
            err = error;
          }
        });
        const job = {
          name: 'called once with interval now',
          data,
          priority: 10,
          unique: 'uniqueJob',
          attempts: 1,
          backoff: {
            delay: 1000,
            type: 'FIXED',
          },
          interval: '',
          when: new Date(),
        };
        await service.createJob(job);
        if (err) {
          throw err;
        }
      }); // END OF it('should allow scheduling one job which runs immediately'
    });
    describe('called multiple times with interval now', () => {
      it('should allow scheduling multiple jobs which run immediately', async () => {
        const n = 3;
        let err;
        await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
          try {
            should.exist(job.data);
            job.data.payload[0].value.toString().should.equal('test Value');
            await jobEvents.emit('jobDone', { id: job.id });
          } catch (error) {
            err = error;
          }
        });
        const reqs = [];
        for (let j = 0; j < n; j += 1) {
          const job = {
            name: 'called multiple times with interval now',
            data,
            priority: 10,
            unique: 'uniqueJob',
            attempts: 1,
            backoff: {
              delay: 1000,
              type: 'FIXED',
            },
            interval: '',
            when: new Date(),
          };
          reqs.push(service.createJob(job));
        }
        await reqs;
        if (err) {
          throw err;
        }
      });
    });
    describe('deleteJob', () => {
      it('should remove a job', async () => {
        const jobID = 'job-to-be-removed';
        await jobEvents.on('queuedJob', async (job, context, configRet, eventNameRet) => {
        await jobEvents.emit('jobDone', { id: job.id });
        });
        const job: any = {
          name: jobID,
          data,
          priority: 10,
          unique: 'uniqueJob',
          attempts: 1,
          backoff: {
            delay: 1000,
            type: 'FIXED',
          },
          interval: '',
          when: new Date(),
        };
        await service.createJob(job);
        await service.deleteJob(job.id, null);
      });
      it('should noop on nonexistent job', async () => {
        await service.deleteJob('job-does-not-exist', null);
      });
    });
  });
});
