import {
  AuthZAction, Decision, PolicySetRQ, accessRequest, Subject, DecisionResponse
} from '@restorecommerce/acs-client';
import * as _ from 'lodash';
import { SchedulingService } from './schedulingService';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createLogger } from '@restorecommerce/logger';
import { GrpcClient } from '@restorecommerce/grpc-client';

export interface HierarchicalScope {
  id: string;
  role?: string;
  children?: HierarchicalScope[];
}

export interface Response {
  payload: any;
  count: number;
  status?: {
    code: number;
    message: string;
  };
}

export interface AccessResponse {
  decision: Decision;
  response?: Response;
}

export enum FilterOperation {
  eq = 0,
  lt = 1,
  lte = 2,
  gt = 3,
  gte = 4,
  isEmpty = 5,
  iLike = 6,
  in = 7,
  neq = 8
}

export enum FilterValueType {
  STRING = 0,
  NUMBER = 1,
  BOOLEAN = 2,
  DATE = 3,
  ARRAY = 4
}

export enum OperatorType {
  and = 0,
  or = 1
}

export interface Filter {
  field: string;
  operation: FilterOperation;
  value: string;
  type?: FilterValueType;
  filters?: FilterOp[];
}

export interface FilterOp {
  filter?: Filter[];
  operator?: OperatorType;
}

export interface ReadPolicyResponse extends AccessResponse {
  policy_sets?: PolicySetRQ[];
  filters?: FilterOp[];
  custom_query_args?: {
    custom_queries: any;
    custom_arguments: any;
  };
}

// Create a ids client instance
let idsClientInstance;
const getUserServiceClient = async () => {
  if (!idsClientInstance) {
    const cfg = createServiceConfig(process.cwd());
    // identity-srv client to resolve subject ID by token
    const grpcIDSConfig = cfg.get('client:user');
    const logger = createLogger(cfg.get('logger'));
    if (grpcIDSConfig) {
      const idsClient = new GrpcClient(grpcIDSConfig, logger);
      idsClientInstance = idsClient.user;
    }
  }
  return idsClientInstance;
};


/**
 * Perform an access request using inputs from a GQL request
 *
 * @param subject Subject information
 * @param resources resources
 * @param action The action to perform
 * @param entity The entity type to check access against
 */
/* eslint-disable prefer-arrow-functions/prefer-arrow-functions */
export async function checkAccessRequest(subject: Subject, resources: any, action: AuthZAction,
  entity: string, service: SchedulingService, resourceNameSpace?: string, useCache = true): Promise<DecisionResponse | ReadPolicyResponse> {
  let authZ = service.authZ;
  let data = _.cloneDeep(resources);
  // resolve subject id using findByToken api and update subject with id
  let dbSubject;
  if (subject && subject.token) {
    const idsClient = await getUserServiceClient();
    if (idsClient) {
      dbSubject = await idsClient.findByToken({ token: subject.token });
      if (dbSubject && dbSubject.payload && dbSubject.payload.id) {
        subject.id = dbSubject.payload.id;
      }
    }
  }
  if (!_.isArray(resources) && action != AuthZAction.READ) {
    data = [resources];
  } else if (action === AuthZAction.READ) {
    data.args = resources;
    data.entity = entity;
  }

  let result: DecisionResponse | ReadPolicyResponse;
  try {
    result = await accessRequest(subject, data, action, authZ, entity, resourceNameSpace, useCache);
  } catch (err) {
    return {
      decision: Decision.DENY,
      operation_status: {
        code: err.code || 500,
        message: err.details || err.message,
      }
    };
  }
  if (result && (result as ReadPolicyResponse).policy_sets) {
    let custom_queries = data.args.custom_queries;
    let custom_arguments = data.args.custom_arguments;
    (result as ReadPolicyResponse).filters = data.args.filters;
    (result as ReadPolicyResponse).custom_query_args = { custom_queries, custom_arguments };
    return result as ReadPolicyResponse;
  } else {
    return result as DecisionResponse;
  }
}