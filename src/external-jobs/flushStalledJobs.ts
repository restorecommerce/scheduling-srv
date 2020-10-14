import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger, Logger } from '@restorecommerce/logger';
import { Events } from '@restorecommerce/kafka-client';
import { marshallProtobufAny } from '../schedulingService';
import * as _ from 'lodash';

const QUEUED_JOBS_TOPIC = 'io.restorecommerce.jobs';
let logger: Logger;

export default async (cfg?: any) => {
  if (!cfg) {
    cfg = createServiceConfig(__dirname + '/../../');
  }
  logger = createLogger(cfg.get('logger'));

  const kafkaCfg = cfg.get('events:kafka');
  const events: Events = new Events(kafkaCfg, logger);
  await events.start();
  const jobTopic = events.topic(QUEUED_JOBS_TOPIC);
  const externalJobsCfg = cfg.get('externalJobs');
  let deleteStalledJobs = false;
  let stalledJobOptions;
  if (externalJobsCfg && _.isArray(externalJobsCfg) && externalJobsCfg.length > 0) {
    for (let extJobCfg of externalJobsCfg) {
      if (extJobCfg && extJobCfg.deleteStalledJobs) {
        deleteStalledJobs = extJobCfg.deleteStalledJobs;
        stalledJobOptions = extJobCfg.stalledJob.options;
        break;
      }
    }
  }

  // Emit job and subscribe a listener for jobDone or jobFailed and check if the id matches
  if (deleteStalledJobs) {
    // create job with the job options in cfg and emit as queedJob event
    const data = {
      payload:
        marshallProtobufAny({
          jobType: stalledJobOptions.jobType
        })
    };
    const job = {
      type: stalledJobOptions.jobType,
      data,
      options: {
        repeat: {
          cron: stalledJobOptions.cronParser
        }
      }
    };
    try {
      await jobTopic.emit('createJobs', { items: [job] });
    } catch (err) {
      logger.error(`Error occured creating ${stalledJobOptions.jobType}:`, err.message);
    }

    jobTopic.on('jobDone', async (job) => {
      if (job.type === stalledJobOptions.jobType) {
        logger.verbose('Job done, stalled Jobs deleted successfully:', job);
      }
    }).catch((err) => logger.error(err));

    jobTopic.on('jobFailed', async (job) => {
      if (job.type === stalledJobOptions.jobType) {
        logger.verbose('Job Failed, stalled Jobs could not be deleted successfully:', job);
      }
    }).catch((err) => logger.error(err));
  }
};

