import * as _ from 'lodash';
import * as chassis from '@restorecommerce/chassis-srv';
import { Events, Topic } from '@restorecommerce/kafka-client';
import { createLogger, Logger } from '@restorecommerce/logger';
import { SchedulingService } from './schedulingService';
import { createServiceConfig } from '@restorecommerce/service-config';
import * as cacheManager from 'cache-manager';
import * as redisStore from 'cache-manager-redis';
import * as fs from 'fs';
import { UI, setQueues } from 'bull-board';
import * as express from 'express';
import { initAuthZ, ACSAuthZ, updateConfig, initializeCache } from '@restorecommerce/acs-client';
import { RedisClient, createClient } from 'redis';

const JOBS_CREATE_EVENT = 'createJobs';
const JOBS_MODIFY_EVENT = 'modifyJobs';
const JOBS_DELETE_EVENT = 'deleteJobs';
const QUEUED_JOB = 'queuedJob';
const FLUSH_STALLED_JOBS_TYPE = 'flushStalledJobs';

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

class JobsCommandInterface extends chassis.CommandInterface {
  schedulingService: SchedulingService;
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events,
    schedulingService: SchedulingService, redisClient: RedisClient) {
    super(server, cfg, logger, events, redisClient);
    this.schedulingService = schedulingService;
  }

  /**
   * Reset system data for job service by deleting all scheduled jobs in Redis.
   * @param call
   * @param context
   */
  async reset(): Promise<any> {
    // Get a redis connection
    await this.schedulingService.clear();
    return {};
  }

  async setApiKey(payload: any): Promise<any> {
    const commandResponse = await super.setApiKey(payload);
    updateConfig(this.config);
    return commandResponse;
  }

  async configUpdate(payload: any): Promise<any> {
    const commandResponse = await super.configUpdate(payload);
    updateConfig(this.config);
    return commandResponse;
  }

  async restore(payload: any): Promise<any> {
    if (_.isNil(payload) || _.keys(payload).length == 0) {
      throw new chassis.errors.InvalidArgument('Invalid payload for restore command');
    }

    this.schedulingService.disableEvents();
    const kafkaCfg = this.config.events.kafka;
    const topicName = kafkaCfg.topics['jobs'].topic;
    const restoreSetup = {};
    if (!_.isEmpty(payload.jobs)) {
      restoreSetup[topicName] = {
        resource: 'jobs',
        topic: this.kafkaEvents.topic(topicName),
        events: this.makeJobsRestoreSetup()
      };
    }

    const that = this;
    for (let topicName in restoreSetup) {
      const topicSetup = restoreSetup[topicName];

      const topic = topicSetup.topic;
      const resource = topicSetup.resource;
      const eventsSetup = topicSetup.events;

      // const eventNames = _.keys(restoreTopic.events);
      const baseOffset: number = payload['jobs'].offset || 0;
      const targetOffset: number = (await topic.$offset(-1)) - 1;
      const ignoreOffsets: number[] = payload[resource].ignore_offset || [];

      const eventNames = _.keys(eventsSetup);
      for (let eventName of eventNames) {
        const listener = eventsSetup[eventName];
        const listenUntil = async (message: any, ctx: any,
          config: any, eventNameRet: string): Promise<any> => {
          that.logger.debug(`received message ${ctx.offset}/${targetOffset}`, ctx);
          if (_.includes(ignoreOffsets, ctx.offset)) {
            return;
          }
          try {
            await listener(message, ctx, config, eventNameRet);
          } catch (e) {
            that.logger.debug('Exception caught :', e.message);
          }
          if (ctx.offset >= targetOffset) {
            const message = {};
            message['topic'] = topic;
            message['offset'] = ctx.offset;
            await that.commandTopic.emit('restoreResponse', {
              services: _.keys(that.service),
              payload: that.encodeMsg(message)
            });

            for (let name of eventNames) {
              that.logger.debug('Number of listeners before removing :',
                topic.listenerCount(name));
              await topic.removeAllListeners(name);
              that.logger.debug('Number of listeners after removing :',
                topic.listenerCount(name));
            }
            that.logger.info('restore process done');

            that.schedulingService.enableEvents();
          }
        };

        this.logger.debug(`listening to topic ${topic} event ${eventName}
        until offset ${targetOffset} while ignoring offset`, ignoreOffsets);
        await topic.on(eventName, listenUntil);
        this.logger.debug(`resetting commit offset of topic ${topic} to ${baseOffset}`);
        await topic.$reset(eventName, baseOffset);
        this.logger.debug(`reset done for topic ${topic} to commit offset ${baseOffset}`);
      }
    }

    return {};
  }

  makeJobsRestoreSetup(): any {
    const that = this;
    return {
      jobsCreated: async function onJobsCreated(message: any, context: any): Promise<any> {
        if (message.when) {
          // If the jobSchedule time has already lapsed then do not schedule
          const jobScheduleTime = new Date(message.when).getTime();
          const currentTime = new Date().getTime();
          if (jobScheduleTime < currentTime) {
            that.logger.info('Skipping the elapsed time job');
            return {};
          }
        }

        if (message.now) {
          that.logger.info('Skipping immediate job');
          return {};
        }

        await that.schedulingService.create({
          request: {
            items: [message]
          }
        });

        return {};
      },
      jobsDeleted: async function restoreDeleted(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await that.schedulingService.delete({
          request: {
            ids: [message.id]
          }
        });
        return {};
      }
    };
  }
}

export class Worker {
  schedulingService: SchedulingService;
  events: Events;
  server: any;
  offsetStore: chassis.OffsetStore;
  logger: Logger;
  app: express.Application;
  authZ: ACSAuthZ;

  async start(cfg: any): Promise<any> {
    // Load config
    if (!cfg) {
      cfg = createServiceConfig(process.cwd());
    }
    // Create a new microservice Server
    const logger = createLogger(cfg.get('logger'));
    this.logger = logger;
    const server = new chassis.Server(cfg.get('server'), logger);

    // Get a redis connection
    const redisConfig = cfg.get('redis');
    redisConfig.db = cfg.get('redis:db-indexes:db-jobStore');

    const reccurTimeCfg = cfg.get('redis');
    reccurTimeCfg.db = cfg.get('redis:db-indexes:db-reccurTime');
    const redisClient = createClient(reccurTimeCfg);

    // Get Rate Limiter config
    const rateLimiterConfig = cfg.get('rateLimiter');

    // Create events
    const kafkaCfg = cfg.get('events:kafka');
    const events: Events = new Events(kafkaCfg, logger);
    await events.start();
    this.offsetStore = new chassis.OffsetStore(events, cfg, logger);

    const JOBS_TOPIC_NAME = kafkaCfg.topics.jobs.topic;
    // Subscribe to events which the business logic requires
    const jobEvents: Topic = events.topic(JOBS_TOPIC_NAME);

    const bullOptions = cfg.get('bull');
    // Create the business logic
    this.authZ = await initAuthZ(cfg) as ACSAuthZ;

    // init redis client for subject index
    const redisConfigSubject = cfg.get('redis');
    redisConfigSubject.db = cfg.get('redis:db-indexes:db-subject');
    const redisSubjectClient = createClient(redisConfigSubject);

    // init ACS cache
    initializeCache();

    const schedulingService: SchedulingService = new SchedulingService(jobEvents,
      redisConfig, logger, redisClient, bullOptions, cfg, this.authZ);
    await schedulingService.start();
    // Bind business logic to server
    const serviceNamesCfg = cfg.get('serviceNames');
    await server.bind(serviceNamesCfg.scheduling, schedulingService);

    const cis = new JobsCommandInterface(server, cfg,
      logger, events, schedulingService, redisSubjectClient);
    await server.bind(serviceNamesCfg.cis, cis);

    const schedulingServiceEventsListener = async (msg: any,
      context: any, config: any, eventName: string): Promise<any> => {

      if (eventName === JOBS_CREATE_EVENT) {
        // protobuf.js appends unnecessary properties to object
        msg.items = _.map(msg.items, schedulingService._filterKafkaJob.bind(schedulingService));
        const call = { request: { items: msg.items, subject: msg.subject, api_key: msg.api_key } };
        // to disableAC and enable scheduling jobs emitted via kafka event 'createJobs'
        await schedulingService.create(call, {}).catch(
          (err) => {
            logger.error(`Error occurred scheduling job, ${err}`);
          });
      }
      else if (eventName === JOBS_MODIFY_EVENT) {
        msg.items = msg.items.map((job) => {
          return schedulingService._filterKafkaJob(job);
        });
        const call = { request: { items: msg.items, subject: msg.subject, api_key: msg.api_key } };
        await schedulingService.update(call, {}).catch(
          (err) => {
            logger.error('Error occurred updating jobs:', err.message);
          });
      }
      else if (eventName === JOBS_DELETE_EVENT) {
        const ids = msg.ids;
        const collection = msg.collection;
        const call = { request: { ids, collection, subject: msg.subject, api_key: msg.api_key } };
        await schedulingService.delete(call, {}).catch(
          (err) => {
            logger.error('Error occurred deleting jobs:', err.message);
          });
      } else if (eventName === QUEUED_JOB) {
        if (msg && msg.type === FLUSH_STALLED_JOBS_TYPE) {
          await schedulingService.flushStalledJobs(msg.id, msg.type).catch(
            (err) => {
              logger.error('Error occured flushing jobs:', err.message);
            });
        }
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
            { startingOffset: offsetValue });
        }
      }
    }

    // Add reflection service
    const reflectionServiceName = serviceNamesCfg.reflection;
    const transportName = cfg.get(`server:services:${reflectionServiceName}:serverReflectionInfo:transport:0`);
    const transport = server.transport[transportName];
    const reflectionService = new chassis.grpc.ServerReflection(transport.$builder, server.config);
    await server.bind(reflectionServiceName, reflectionService);

    await server.bind(serviceNamesCfg.health, new chassis.Health(cis, {
      logger,
      cfg,
      dependencies: ['acs-srv'],
    }));

    // Hook any external jobs
    const externalJobFiles = fs.readdirSync('./lib/external-jobs');
    externalJobFiles.forEach((externalFile) => {
      if (externalFile.endsWith('.js')) {
        (async () => require('./external-jobs/' + externalFile).default(cfg))().catch(err => {
          this.logger.error(`Error scheduling external job ${externalFile}`, { err: err.message });
        });
      }
    });

    // Start server
    await server.start();

    this.schedulingService = schedulingService;
    this.events = events;
    this.server = server;

    setQueues(this.schedulingService.queuesList);

    this.app = express();
    this.app.use(cfg.get('bull:board:path'), UI);
    this.app.listen(cfg.get('bull:board:port'), () => {
      logger.info(`Bull board listening on port ${cfg.get('bull:board:port')} at ${cfg.get('bull:board:path')}`);
    });
  }

  async stop(): Promise<any> {
    this.server.logger.info('Shutting down');
    await this.server.stop();
    await this.events.stop();
    await this.offsetStore.stop();
  }
}

if (require.main === module) {
  const worker = new Worker();
  const cfg = createServiceConfig(process.cwd());
  worker.start(cfg).then().catch((err) => {
    worker.logger.error('startup error:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    worker.stop().then().catch((err) => {
      worker.logger.error('shutdown error:', err);
      process.exit(1);
    });
  });
}
