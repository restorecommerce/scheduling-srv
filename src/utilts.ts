import {
  AuthZAction, accessRequest, DecisionResponse, Operation, PolicySetRQResponse
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger } from '@restorecommerce/logger';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import {
  UserServiceClient,
  UserServiceDefinition
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';
import {
  Response_Decision
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import { Subject } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/auth';
import { JobsOptions, Worker } from 'bullmq';
import { Processor } from 'bullmq';
import { FilterOpts, JobType, KafkaOpts, Priority } from './types';
import { parseInt } from 'lodash';
import { Data } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job';
import { Attribute } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/attribute';
import { createClient as createRedisClient } from 'redis';
import { Events } from '@restorecommerce/kafka-client';
import { Logger } from 'winston';

// Create a ids client instance
let idsClientInstance: UserServiceClient;
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const loggerCfg = cfg.get('logger');
    loggerCfg.esTransformer = (msg) => {
      msg.fields = JSON.stringify(msg.fields);
      return msg;
    };
    const logger = createLogger(loggerCfg);
    if (grpcIDSConfig) {
      idsClientInstance = createClient({
        ...grpcIDSConfig,
        logger
      }, UserServiceDefinition, createChannel(grpcIDSConfig.address));
    }
  }
  return idsClientInstance;
};

export interface Resource {
  resource: string;
  id?: string | string[]; // for what is allowed operation id is not mandatory
  property?: string[];
}

export interface CtxResource {
  id: string;
  meta: {
    created?: Date;
    modified?: Date;
    modified_by?: string;
    owners: Attribute[]; // id and owner is mandatory in ctx resource other attributes are optional
  };
  [key: string]: any;
}

export interface GQLClientContext {
  // if subject is missing by default it will be treated as unauthenticated subject
  subject?: Subject;
  resources?: CtxResource[];
}

// Marshall any job payload to google.protobuf.Any
export const marshallProtobufAny = (data: any): any => {
  const stringified = JSON.stringify(data);
  return {
    type_url: '',
    value: Buffer.from(stringified)
  };
};

// Unmarshall a job payload.
export const unmarshallProtobufAny = (data: any, logger: Logger): any => {
  let unmarshalled = {};
  try {
    if (!_.isEmpty(data)) {
      const payloadValue = data.value;
      const decoded = payloadValue.toString();
      if (!_.isEmpty(decoded)) {
        unmarshalled = JSON.parse(decoded);
      }
    }
  } catch (error) {
    logger.error('Error unmarshalling job payload', {
      data, code: error.code,
      message: error.message, stack: error.stack
    });
  }

  return unmarshalled;
};

export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction, operation: Operation.isAllowed): Promise<DecisionResponse>;
export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction, operation: Operation.whatIsAllowed): Promise<PolicySetRQResponse>;

/**
 * Perform an access request using inputs from a GQL request
 *
 * @param ctx GQLClientContext containing subject and resources
 * @param resource resource contains target resoruce, id and properties if any
 * @param action The action to perform
 * @param operation Operation either isAllowed or whatIsAllowed
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(ctx: GQLClientContext, resource: Resource[], action: AuthZAction,
  operation: Operation): Promise<DecisionResponse | PolicySetRQResponse> {
  let subject = ctx.subject;
  // resolve subject id using findByToken api and update subject with id
  let dbSubject;
  if (subject?.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject?.payload?.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }

  let result: DecisionResponse | PolicySetRQResponse;
  try {
    result = await accessRequest(subject, resource, action, ctx, operation);
  } catch (err) {
    return {
      decision: Response_Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  return result;
}

export function _filterJobData(data: Data, encode: boolean, logger: Logger): Pick<Data, 'meta' | 'payload' | 'subject_id'> {
  const picked = _.pick(data, [
    'meta', 'payload', 'subject_id'
  ]);

  if (encode) {
    if (picked?.payload?.value && typeof picked.payload.value === 'string') {
      (picked as any).payload = marshallProtobufAny(unmarshallProtobufAny(picked.payload, logger));
    }
  }

  if(picked?.meta?.created && typeof picked.meta.created === 'string') {
    picked.meta.created = new Date(picked.meta.created);
  }

  if(picked?.meta?.modified && typeof picked.meta.modified === 'string') {
    picked.meta.modified = new Date(picked.meta.modified);
  }

  return picked as any;
}


export function _filterQueuedJob<T extends FilterOpts>(job: T, logger: Logger): Pick<T, 'id' | 'type' | 'data' | 'opts' | 'name'> {
  if (job && !job.type) {
    (job as any).type = (job as any).name;
  }
  const picked: any = _.pick(job, [
    'id', 'type', 'data', 'opts', 'name'
  ]);

  if (picked?.data) {
    picked.data = _filterJobData(picked.data, false, logger);
    if (picked?.data?.payload?.value) {
      picked.data.payload.value = Buffer.from(picked.data.payload.value);
    }
  }

  return picked as any;
}

export function _filterKafkaJob<T extends KafkaOpts>(job: T, logger: Logger): Pick<T, 'id' | 'type' | 'data' | 'options' | 'when'> {
  const picked: any = _.pick(job, [
    'id', 'type', 'data', 'options', 'when', 'queue_name'
  ]);

  if (picked?.data?.payload?.value) {
    // Re-marshal because protobuf messes up toJSON
    picked.data.payload = marshallProtobufAny(unmarshallProtobufAny(picked.data.payload, logger));
  }

  return picked as any;
}

export function _filterJobOptions(data: JobsOptions): Pick<JobsOptions, 'priority' | 'attempts' | 'backoff' | 'repeat' | 'jobId' | 'removeOnComplete'> {
  let picked = _.pick(data, [
    'priority', 'attempts', 'backoff', 'repeat', 'jobId', 'removeOnComplete'
  ]);

  if (typeof picked?.priority === 'number') {
    picked.priority = Priority[picked.priority] as any;
  }

  if (typeof picked?.backoff === 'object') {
    if (!picked.backoff.type) {
      picked.backoff.type = 'FIXED';
    } else {
      picked.backoff.type = picked.backoff.type.toUpperCase();
    }
  }
  // remove key if it exists in repeat
  if ((picked?.repeat as any)?.key) {
    delete (picked.repeat as any).key;
  }

  return picked;
}
