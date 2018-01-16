'use strict';

import * as co from 'co';
import * as _ from 'lodash';
import * as protobuf from 'protobufjs';
import * as chassis from '@restorecommerce/chassis-srv';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { JobResourceService } from './jobResourceService';
import { SchedulingService } from './schedulingService';
import * as sconfig from '@restorecommerce/service-config';
import * as cacheManager from 'cache-manager';
import * as redisStore from 'cache-manager-redis';

const Server = chassis.Server;
const database = chassis.database;
const grpc = chassis.grpc;
// Topics
const COLLECTION_NAME = 'jobs';
// Topic the jobs are stored as resources
const JOBS_RESOURCE_TOPIC_NAME = 'io.restorecommerce.jobs.resource';
const HEALTH_CMD_EVENT = 'healthCheckCommand';
const HEALTH_RES_EVENT = 'healthCheckResponse';
const RESET_START_EVENT = 'resetCommand';
const RESET_DONE_EVENT = 'resetResponse';
const RESTORE_CMD_EVENT = 'restoreCommand';
const JOBS_CREATE_EVENT = 'createJobs';
const JOBS_MODIFY_EVENT = 'modifyJobs';
const JOBS_DELETE_EVENT = 'deleteJobs';

chassis.cache.register('redis', (cacheConfig, logger) => {
  const options = {
    store: redisStore,
    host: cacheConfig.host,
    port: cacheConfig.port,
    auth_pass: cacheConfig.authPass,
    db: cacheConfig.db,
    ttl: cacheConfig.ttl,
  };
  return cacheManager.caching(options);
});

export class Worker {
  schedulingService: SchedulingService;
  jobResourceService: JobResourceService;
  events: Events;
  server: any;

  async start(cfg: any): Promise<any> {
    // Load config
    if (!cfg) {
      cfg = sconfig(process.cwd());
    }
    // Create a new microservice Server
    const logger = new Logger(cfg.get('logger'));
    const server = new Server(cfg.get('server'), logger);

    // Get database connection
    const db = await co(database.get(cfg.get('database:main'), logger));

    let jobResources;
    try {
      jobResources = await co(db.find(COLLECTION_NAME, {}));
    } catch (err) {
      logger.info('No Jobs found:', err);
    }
    const jobNames = _.map(jobResources, jr => {
      return jr.name;
    });
    logger.verbose(`found ${jobNames.length} job resource(s)`, jobNames);

    // Get a redis connection
    const redis = await co(chassis.cache.get(cfg.get('cache:kue-scheduler'), logger));

    // Filter jobResources based on already queued jobs in redis
    const missingJobNames = [];
    for (let i = 0; i < jobNames; i += 1) {
      const jobName = jobNames[i];
      const keys = await (() => {
        return (cb) => {
          redis.keys(`scheduling-srv:jobs:${jobName}*`, cb);
        };
      });
      if (keys.length === 0) {
        missingJobNames.push(jobName);
      }
    }
    const missingJobs = _.filter(jobResources, (jr) => {
      return _.includes(missingJobNames, jr.name);
    });

    logger.verbose(`missing ${missingJobs.length} job(s) in redis`,
      _.map(missingJobs, jr => {
        return jr.name;
      }));

    // Create events
    let kafkaCfg = cfg.get('events:kafka');
    const commandTopic = kafkaCfg.topics.command.topic;
    const events: Events = new Events(kafkaCfg, logger);
    await events.start();

    const JOBS_TOPIC_NAME = kafkaCfg.jobsTopic;
    // Subscribe to events which the business logic requires
    const jobResourceEvents: Topic = events.topic(JOBS_RESOURCE_TOPIC_NAME);
    const jobEvents: Topic = events.topic(JOBS_TOPIC_NAME);

    // Create the business logic
    const redisConfig: any = cfg.get('cache:kue-scheduler:0');
    const service: SchedulingService = new
      SchedulingService(jobEvents, redisConfig, cfg, logger);
    await co(service.start(missingJobs));
    // schedule existing jobs in the database
    for (let i = 0; i < jobResources.length; i++) {
      jobResources[i].data = _.toPlainObject(jobResources[i].data);
      await service.createJob(jobResources[i]);
    }

    // Create CRUD REST interface
    const jobResourceService: JobResourceService = new
      JobResourceService(jobResourceEvents, db, logger);
    jobResourceService.emitter.on('createJobs',
      async function onCreated(jobs: any): Promise<any> {
        const createJobs = [];
        for (let i = 0; i < jobs.length; i++) {
          jobs[i].data = _.toPlainObject(jobs[i].data);
          createJobs.push(service.createJob(jobs[i]));
        }
        await createJobs;
      });
    jobResourceService.emitter.on('deleteJobs',
      async function onDeleted(jobs: any): Promise<any> {
        const deleteJobs = [];
        for (let i = 0; i < jobs.length; i++) {
          deleteJobs.push(service.deleteJob(jobs[i].id, jobs[i].job_unique_name));
        }
        await deleteJobs;
      });
    jobResourceService.emitter.on('modifyJobs',
      async function onUpdated(jobs: any): Promise<any> {
        const calls = [];
        for (let i = 0; i < jobs.length; i++) {
          calls.push(service.deleteJob(jobs[i].id, jobs[i].job_unique_name));
          calls.push(service.createJob(jobs[i]));
        }
        await calls;
      });
    // Bind business logic to server
    const serviceNamesCfg = cfg.get('serviceNames');
    await co(server.bind(serviceNamesCfg.scheduling, jobResourceService));

    // Add CommandInterfaceService
    const cis: any = new JobsCommandInterface(server, cfg.get(),
      logger, events, service);
    await co(server.bind(serviceNamesCfg.cis, cis));
    let schedulingServiceEventsListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      let requestObject = msg;
      if (eventName === HEALTH_CMD_EVENT && requestObject &&
        requestObject.service === serviceNamesCfg.scheduling) {
        const serviceStatus = await cis.check(requestObject);
        const healthCheckTopic = events.topic(commandTopic);
        await healthCheckTopic.emit(HEALTH_RES_EVENT, serviceStatus);
      }
      else if (eventName === RESTORE_CMD_EVENT) {
        // the response would be sent from CIS chassis service
        await cis.restore(msg, context);
      }
      else if (eventName === RESET_START_EVENT) {
        const resetStatus = await cis.reset(requestObject, context);
        if (resetStatus) {
          const healthCheckTopic = events.topic(commandTopic);
          await healthCheckTopic.emit(RESET_DONE_EVENT, resetStatus);
        }
      }
      else if (eventName === JOBS_CREATE_EVENT) {
        const call = { request: { items: requestObject.items } };
        jobResourceService.create(call, {});
      }
      else if (eventName === JOBS_MODIFY_EVENT) {
        const call = { request: { items: requestObject.items } };
        jobResourceService.update(call, {});
      }
      else if (eventName === JOBS_DELETE_EVENT) {
        const ids = requestObject.ids;
        const id = requestObject.id;
        const job_unique_name = requestObject.job_unique_name;
        const call = { request: { ids, id, job_unique_name } };
        jobResourceService.delete(call, {});
      }
    };

    let topics = {};
    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      topics[topicType] = events.topic(topicName);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await topics[topicType].on(eventName, schedulingServiceEventsListener);
        }
      }
    }

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new grpc.ServerReflection(transport.$builder, server.config);
    await co(server.bind(reflectionServiceName, reflectionService));

    // Start server
    await co(server.start());

    this.schedulingService = service;
    this.jobResourceService = jobResourceService;
    this.events = events;
    this.server = server;
  }

  async stop(): Promise<any> {
    this.server.logger.info('Shutting down');
    await co(this.server.end());
    await this.events.stop();
  }
}

class JobsCommandInterface extends chassis.CommandInterface {
  service: any;
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events,
    service: SchedulingService) {
    super(server, cfg, logger, events);
    this.service = service;
  }

  /**
   * Reset system data for job service by deleting all scheduled jobs.
   * @param call
   * @param context
   */
  async reset(call: any, context?: any): Promise<any> {
    await super.reset(call, context);
    // Get a redis connection
    const redis = await co(chassis.cache.get(this.config.cache['kue-scheduler'],
      this.logger));
    const keys: any = await new Promise(function (resolve: any, reject: any): any {
      redis.keys('scheduling-srv:*', (err, keyData) => {
        resolve(keyData);
        return keyData;
      });
    });
    for (let i = 0; i < keys.length; i++) {
      redis.del(keys[i], (err, done) => {
      });
    }
    // Delete all the jobs in the jobs resource database
    super.reset(call, context);
  }

  makeResourcesRestoreSetup(db: any, collectionName: string): any {
    const that = this;
    return {
      jobsCreated: async function onJobsCreated(message: Object, context: any): Promise<any> {
        // Schedule the job to redis using scheduling service
        that.service.createJob(message);
        // Insert the job in DB and as well
        await co(db.insert('jobs', message));
        return {};
      },
      jobsModified: async function onJobsModified(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        that.service.deleteJob(message.id, message.job_unique_name);
        that.service.createJob(message);
        await co(db.update(collectionName, { id: message.id }, _.omitBy(message, _.isNil)));
        return {};
      },
      jobsDeleted: async function restoreDeleted(message: any, context: any,
        config: any, eventName: string): Promise< any> {
        that.service.deleteJob(message.id, message.job_unique_name);
        await co(db.delete(collectionName, { id: message.id }));
        return {};
      }
    };
  }
}

if (require.main === module) {
  const worker = new Worker();
  co(worker.start).catch((err) => {
    console.error('startup error', err);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    co(worker.stop).catch((err) => {
      console.error('shutdown error', err);
      process.exit(1);
    });
  });
}
