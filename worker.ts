import * as co from 'co';
import * as _ from 'lodash';
import * as protobuf from 'protobufjs';
import * as chassis from '@restorecommerce/chassis-srv';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as Logger from '@restorecommerce/logger';
import { SchedulingService } from './schedulingService';
import * as sconfig from '@restorecommerce/service-config';
import * as cacheManager from 'cache-manager';
import * as redisStore from 'cache-manager-redis';

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
  events: Events;
  server: any;
  offsetStore: chassis.OffsetStore;

  async start(cfg: any): Promise<any> {
    // Load config
    if (!cfg) {
      cfg = sconfig(process.cwd());
    }
    // Create a new microservice Server
    const logger = new Logger(cfg.get('logger'));
    const server = new chassis.Server(cfg.get('server'), logger);

    // Get a redis connection
    const redisConfig = cfg.get('redis');
    redisConfig.db = cfg.get('redis:db-indexes:db-jobStore');
    const redis = await co(chassis.cache.get([redisConfig], logger));

    // Create events
    const kafkaCfg = cfg.get('events:kafka');
    const commandTopic = kafkaCfg.topics.command.topic;
    const events: Events = new Events(kafkaCfg, logger);
    await events.start();
    this.offsetStore = new chassis.OffsetStore(events, cfg, logger);

    const JOBS_RESOURCE_TOPIC_NAME = kafkaCfg.topics['jobs.resource'].topic;
    const JOBS_TOPIC_NAME = kafkaCfg.topics.jobs.topic;
    // Subscribe to events which the business logic requires
    const jobResourceEvents: Topic = events.topic(JOBS_RESOURCE_TOPIC_NAME);
    const jobEvents: Topic = events.topic(JOBS_TOPIC_NAME);

    // Create the business logic
    const schedulingService: SchedulingService = new SchedulingService(jobEvents, jobResourceEvents, redisConfig, logger, redis);
    await schedulingService.start();

    // Bind business logic to server
    const serviceNamesCfg = cfg.get('serviceNames');
    await co(server.bind(serviceNamesCfg.scheduling, schedulingService));

    const cis: chassis.ICommandInterface = new JobsCommandInterface(server, cfg.get(),
      logger, events, schedulingService);
    await co(server.bind(serviceNamesCfg.cis, cis));

    const schedulingServiceEventsListener = async function eventListener(msg: any,
      context: any, config: any, eventName: string): Promise<any> {
      if (eventName === JOBS_CREATE_EVENT) {
        // protobuf.js appends unnecessary properties to object
        msg.items = _.map(msg.items, schedulingService._filterKafkaJob.bind(schedulingService));
        const call = { request: { items: msg.items } };
        await schedulingService.create(call, {});
      }
      else if (eventName === JOBS_MODIFY_EVENT) {
        msg.items = msg.items.map((job) => {
          return schedulingService._filterKafkaJob(job);
        });
        const call = { request: { items: msg.items } };
        await schedulingService.update(call, {});
      }
      else if (eventName === JOBS_DELETE_EVENT) {
        const ids = msg.ids;
        const collection = msg.collection;
        const call = { request: { ids, collection } };
        await schedulingService.delete(call, {});
      } else {  // commands
        await cis.command(msg, context);
      }
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      const topic = events.topic(topicName);
      const offsetValue = await this.offsetStore.getOffset(topicName);
      logger.info('subscribing to topic with offset value', topicName, offsetValue);
      if (kafkaCfg.topics[topicType].events) {
        const eventNames = kafkaCfg.topics[topicType].events;
        for (let eventName of eventNames) {
          await topic.on(eventName, schedulingServiceEventsListener,
            offsetValue);
        }
      }
    }

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await co(server.bind(reflectionServiceName, reflectionService));

    // Start server
    await co(server.start());

    this.schedulingService = schedulingService;
    this.events = events;
    this.server = server;
  }

  async stop(): Promise<any> {
    this.server.logger.info('Shutting down');
    await co(this.server.end());
    await this.events.stop();
    await this.offsetStore.stop();
  }
}

class JobsCommandInterface extends chassis.CommandInterface {
  schedulingService: SchedulingService;
  cfg: any;
  logger: any;
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events,
    schedulingService: SchedulingService) {
    super(server, cfg, logger, events);
    this.schedulingService = schedulingService;
    this.cfg = cfg;
    this.logger = logger;
  }

  /**
   * Reset system data for job service by deleting all scheduled jobs.
   * @param call
   * @param context
   */
  async reset(): Promise<any> {
    // await super.reset();
    // const that = this;
    // // Get a redis connection
    // const redisConfig = this.cfg.redis;
    // const dbIndexes = this.cfg.redis['db-indexes'];
    // redisConfig.db = dbIndexes['db-jobStore'];
    // const redis = await co(chassis.cache.get([redisConfig], this.logger));
    // const keys: any = await new Promise(function (resolve: any, reject: any): any {
    //   redis.keys('scheduling-srv:*', (err, keyData) => {
    //     resolve(keyData);
    //     that.logger.info('Redis job keys are :', keyData);
    //   });
    // });
    // for (let i = 0; i < keys.length; i++) {
    //   redis.del(keys[i], (err, done) => {
    //   });
    // }
    return {};
  }

  makeResourcesRestoreSetup(db: any, collectionName: string): any {
    const that = this;
    return {
      // jobsCreated: async function onJobsCreated(message: any, context: any): Promise<any> {
      //   if (message.when) {
      //     // If the jobSchedule time has already lapsed then do not schedule
      //     // the job - fix for kue-scheduler bug.
      //     const jobScheduleTime = new Date(message.when).getTime();
      //     const currentTime = new Date().getTime();
      //     if (jobScheduleTime < currentTime) {
      //       that.logger.info('Skipping the elapsed time job');
      //       return {};
      //     }
      //   }

      //   // the message received from Kafka would be array of integers i.e. utf-8
      //   // convert it to base64 again
      //   if (message.data && message.data.payload && message.data.payload.value) {
      //     message.data.payload = marshallProtobufAny(JSON.parse(
      //       message.data.payload.value.toString()));
      //   }
      //   message.data = _.pick(message.data, ['timezone', 'payload']);
      //   // Schedule the job to redis using scheduling service
      //   that.schedulingService.create([message]);
      //   // Insert the job in DB and as well
      //   await co(db.insert('jobs', message));
      //   return {};
      // },
      // jobsModified: async function onJobsModified(message: any, context: any,
      //   config: any, eventName: string): Promise<any> {
      //   that.schedulingService.deleteJob(message.id, message.job_unique_name);
      //   that.schedulingService.createJob(message);
      //   await co(db.update(collectionName, { id: message.id }, _.omitBy(message, _.isNil)));
      //   return {};
      // },
      // jobsDeleted: async function restoreDeleted(message: any, context: any,
      //   config: any, eventName: string): Promise<any> {
      //   that.schedulingService.deleteJob(message.id, message.job_unique_name);
      //   await co(db.delete(collectionName, { id: message.id }));
      //   return {};
      // }
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
