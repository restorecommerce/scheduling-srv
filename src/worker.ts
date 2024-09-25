import * as _ from 'lodash-es';
import * as chassis from '@restorecommerce/chassis-srv';
import { Events, Topic, registerProtoMeta } from '@restorecommerce/kafka-client';
import { createLogger } from '@restorecommerce/logger';
import { Logger } from 'winston';
import { SchedulingService } from './schedulingService.js';
import { createServiceConfig } from '@restorecommerce/service-config';
import * as fs from 'node:fs';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import { initAuthZ, ACSAuthZ, updateConfig, initializeCache } from '@restorecommerce/acs-client';
import { createClient, RedisClientType } from 'redis';
import { protoMetadata as schedulingMeta, JobServiceDefinition as SchedulingServiceDefinition, JobList } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job.js';
import { protoMetadata as commandInterfaceMeta, CommandInterfaceServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface.js';
import {
  protoMetadata as reflectionMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/reflection/v1alpha/reflection.js';
import {
  protoMetadata as renderingMeta
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rendering.js';
import { ServerReflectionService } from 'nice-grpc-server-reflection';
import { BindConfig } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc/index.js';
import { HealthDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/health/v1/health.js';
import { DeleteRequest, protoMetadata as resourceBaseMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base.js';
import { _filterKafkaJob } from './utilts.js';
import { runWorker } from '@restorecommerce/scs-jobs';
import express from 'express';

const JOBS_CREATE_EVENT = 'createJobs';
const JOBS_MODIFY_EVENT = 'modifyJobs';
const JOBS_DELETE_EVENT = 'deleteJobs';
const COMMANDS_EVENTS = ['healthCheckCommand', 'versionCommand', 'restoreCommand',
  'resetCommand', 'configUpdateCommand', 'flushCacheCommand'];

registerProtoMeta(
  schedulingMeta,
  commandInterfaceMeta,
  reflectionMeta,
  resourceBaseMeta, // needed for `deleteJobs` event - io.restorecommerce.resourcebase.DeleteRequest
  renderingMeta // needed for encoding and decoding of render-request messages (used for external jobs in SCS)
);

class JobsCommandInterface extends chassis.CommandInterface {
  schedulingService: SchedulingService;
  constructor(server: chassis.Server, cfg: any, logger: any, events: Events,
    schedulingService: SchedulingService, redisClient: RedisClientType<any, any>) {
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
    const restoreSetup: any = {};
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
          } catch (e: any) {
            that.logger.debug('Exception caught :', e.message);
          }
          if (ctx.offset >= targetOffset) {
            const message = {
              topic,
              offset: ctx.offset,
            };
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
        if (message?.when) {
          // If the jobSchedule time has already lapsed then do not schedule
          const jobScheduleTime = new Date(message.when).getTime();
          const currentTime = new Date().getTime();
          if (jobScheduleTime < currentTime) {
            that.logger.info('Skipping the elapsed time job');
            return {};
          }
        }

        if (message?.now) {
          that.logger.info('Skipping immediate job');
          return {};
        }

        await that.schedulingService.create(JobList.fromPartial({
          items: [message]
        }), {});

        return {};
      },
      jobsDeleted: async function restoreDeleted(message: any, context: any,
        config: any, eventName: string): Promise<any> {
        await that.schedulingService.delete(DeleteRequest.fromPartial({
          ids: [message.id]
        }), {});
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
  app: any;
  authZ: ACSAuthZ;
  bullBoardServer: any;

  async start(cfg: any): Promise<any> {
    // Load config
    if (!cfg) {
      cfg = createServiceConfig(process.cwd());
    }
    // Create a new microservice Server
    const loggerCfg = cfg.get('logger');
    const logger = createLogger(loggerCfg);
    this.logger = logger;
    const server = new chassis.Server(cfg.get('server'), logger);

    // Get a redis connection
    const redisConfig = cfg.get('redis');
    // below config is used for bull queu options and it still uses db config
    redisConfig.db = cfg.get('redis:db-indexes:db-jobStore');

    const reccurTimeCfg = cfg.get('redis');
    reccurTimeCfg.database = cfg.get('redis:db-indexes:db-reccurTime');
    const redisClient: RedisClientType<any, any> = createClient(reccurTimeCfg);
    redisClient.on('error', (err) => logger.error('Redis client error in recurring time store', err));
    await redisClient.connect();

    // Get Rate Limiter config
    const rateLimiterConfig = cfg.get('rateLimiter');

    // Create events
    const kafkaCfg = cfg.get('events:kafka');
    const events: Events = new Events(kafkaCfg, logger);
    await events.start();
    this.offsetStore = new chassis.OffsetStore(events, cfg, logger);

    const JOBS_TOPIC_NAME = kafkaCfg.topics.jobs.topic;
    // Subscribe to events which the business logic requires
    const jobEvents: Topic = await events.topic(JOBS_TOPIC_NAME);

    const bullOptions = cfg.get('bull');
    // Create the business logic
    this.authZ = await initAuthZ(cfg) as ACSAuthZ;

    // init redis client for subject index
    const redisConfigSubject = cfg.get('redis');
    redisConfigSubject.database = cfg.get('redis:db-indexes:db-subject');
    const redisSubjectClient: RedisClientType<any, any> = createClient(redisConfigSubject);
    redisSubjectClient.on('error', (err) => logger.error('Redis client error in subject store', err));
    await redisSubjectClient.connect();

    // init ACS cache
    await initializeCache();

    const schedulingService: SchedulingService = new SchedulingService(jobEvents,
      redisConfig, logger, redisClient, bullOptions, cfg, this.authZ);
    await schedulingService.start();
    // Bind business logic to server
    const serviceNamesCfg = cfg.get('serviceNames');
    await server.bind(serviceNamesCfg.scheduling, {
      service: SchedulingServiceDefinition,
      implementation: schedulingService
    } as BindConfig<SchedulingServiceDefinition>);

    // cleanup job
    const queueCleanup = cfg.get('queueCleanup');
    if (queueCleanup?.cleanInterval && typeof queueCleanup.cleanInterval === 'number') {
      await schedulingService.setupCleanInterval(queueCleanup.cleanInterval, queueCleanup.ttlAfterFinished, queueCleanup.maxJobsToCleanLimit);
    }

    const cis = new JobsCommandInterface(server, cfg,
      logger, events, schedulingService, redisSubjectClient);
    await server.bind(serviceNamesCfg.cis, {
      service: CommandInterfaceServiceDefinition,
      implementation: cis
    } as BindConfig<CommandInterfaceServiceDefinition>);

    const schedulingServiceEventsListener = async (msg: any,
      context: any, config: any, eventName: string): Promise<any> => {

      if (eventName === JOBS_CREATE_EVENT) {
        // protobuf.js appends unnecessary properties to object
        msg.items = _.map(msg.items, _filterKafkaJob.bind(schedulingService));
        // to disableAC and enable scheduling jobs emitted via kafka event 'createJobs'
        await schedulingService.create(JobList.fromPartial({ items: msg.items, subject: msg.subject }), {}).catch(
          (err) => {
            logger.error(`Error occurred scheduling job, ${err}`);
          });
      } else if (eventName === JOBS_MODIFY_EVENT) {
        msg.items = msg.items.map((job: any) => {
          return _filterKafkaJob(job, logger);
        });
        await schedulingService.update(JobList.fromPartial({ items: msg.items, subject: msg.subject }), {}).catch(
          (err) => {
            logger.error('Error occurred updating jobs:', err.message);
          });
      } else if (eventName === JOBS_DELETE_EVENT) {
        const ids = msg.ids;
        const collection = msg.collection;
        await schedulingService.delete(DeleteRequest.fromPartial({ ids, collection, subject: msg.subject }), {}).catch(
          (err) => {
            logger.error('Error occurred deleting jobs:', err.message);
          });
      } else if (COMMANDS_EVENTS.indexOf(eventName) > -1) {  // commands
        await cis.command(msg, context);
      }
    };

    const topicTypes = _.keys(kafkaCfg.topics);
    for (let topicType of topicTypes) {
      const topicName = kafkaCfg.topics[topicType].topic;
      const topic = await events.topic(topicName);
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
    const reflectionService = chassis.buildReflectionService([
      { descriptor: schedulingMeta.fileDescriptor },
      { descriptor: commandInterfaceMeta.fileDescriptor }
    ]);
    await server.bind(reflectionServiceName, {
      service: ServerReflectionService,
      implementation: reflectionService
    });

    await server.bind(serviceNamesCfg.health, {
      service: HealthDefinition,
      implementation: new chassis.Health(cis, {
        logger,
        cfg,
        dependencies: ['acs-srv'],
      })
    } as BindConfig<HealthDefinition>);

    // Hook any external jobs
    let externalJobFiles;
    try {
      externalJobFiles = fs.readdirSync(process.env.EXTERNAL_JOBS_DIR || './lib/external-jobs');
    } catch (err: any) {
      if (err.message.includes('no such file or directory')) {
        this.logger.info('No files for external job processors found');
      } else {
        this.logger.error('Error reading external-jobs files');
      }
    }
    if (externalJobFiles?.length > 0) {
      externalJobFiles.forEach(async (externalFile) => {
        if (externalFile.endsWith('.js') || externalFile.endsWith('.cjs')) {
          const require_dir = process.env.EXTERNAL_JOBS_REQUIRE_DIR ?? './jobs/';

          try {
            const fileImport = await import(require_dir + externalFile);
            // check for double default
            if (fileImport?.default?.default) {
              await fileImport.default.default(cfg, logger, events, runWorker);
            } else {
              await fileImport.default(cfg, logger, events, runWorker);
            }
          }
          catch (err: any) {
            this.logger.error(`Error scheduling external job ${externalFile}`, { err });
          }
        }
      });
    }

    // Start server
    await server.start();

    this.schedulingService = schedulingService;
    this.events = events;
    this.server = server;

    const serverAdapter = new ExpressAdapter();
    let queues: BullMQAdapter[] = this.schedulingService.queuesList.map(q => new BullMQAdapter(q));
    createBullBoard({
      queues,
      serverAdapter,
      options: {
        uiBasePath: cfg.get('bull:board:path'),
        uiConfig: {}
      }
    });

    // since node_modules is not copied for ESM bundle support bull-board static files
    // are copied inside lib
    const viewsPath = './lib/@bull-board/ui/dist';
    this.app = express();
    serverAdapter.setBasePath(cfg.get('bull:board:path'));
    serverAdapter.setViewsPath(viewsPath).setStaticPath('/static', viewsPath.concat('/static'));

    this.app.use(cfg.get('bull:board:path'), serverAdapter.getRouter());
    this.bullBoardServer = this.app.listen(cfg.get('bull:board:port'), () => {
      logger.info(`Bull board listening on port ${cfg.get('bull:board:port')} at ${cfg.get('bull:board:path')}`);
    });
    logger.info('Server started successfully');
  }

  async stop(): Promise<any> {
    this.server.logger.info('Shutting down');
    if (this.bullBoardServer) {
      this.bullBoardServer.close();
    }
    await this.server.stop();
    await this.events.stop();
    await this.offsetStore.stop();
  }
}
