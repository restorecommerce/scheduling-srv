import { unmarshallProtobufAny } from '../src/utilts.js';
import { expect } from 'vitest';
import { Priority } from '../src/types.js';
import { Logger } from 'winston';
import { PolicySetRQResponse } from '@restorecommerce/acs-client';
import { Effect } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rule.js';
import { createServiceConfig } from '@restorecommerce/service-config';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import {
  JobServiceDefinition as SchedulingServiceDefinition,
  JobServiceClient as SchedulingServiceClient,
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job.js';

export const cfg = createServiceConfig(process.cwd());

let _client: SchedulingServiceClient
export function getSchedulingServiceClient(logger: Logger) {
  const schedulingClientCfg = cfg.get('client:schedulingClient');
  _client = createClient(
    {
      ...schedulingClientCfg,
      logger
    },
    SchedulingServiceDefinition,
    createChannel(schedulingClientCfg.address)
  );
  return _client;
}

export function validateScheduledJob(job: any, expectedSchedule: string, logger: Logger): void {
  const payload = unmarshallProtobufAny(job.data.payload, logger);
  expect(payload.testValue).to.equal('test-value');
  expect(job.type).to.equal('test-job');
}

export function validateJobDonePayload(job: any, logger: Logger): void {
  if (job && job.result) {
    expect(job.result);
    const payload = unmarshallProtobufAny(job.result, logger);
    expect(payload.testValue).to.equal('test-value');
  }
}

export function validateJob(job: any, logger: Logger): void {
  const payload = unmarshallProtobufAny(job.data.payload, logger);
  expect(payload.testValue).to.equal('test-value');
  expect(job.type).to.equal('test-job');
  expect(job.queue_name).to.equal('test-job');
  expect(job.options.attempts).to.equal(1);
}

export function payloadShouldBeEmpty(result: any, emptyArray: boolean = true): void {
  if (emptyArray) {
    expect(result.items.length).to.equal(0);
  } else {
    // since grpc read does not return empty elements after making fields optional
    expect(result.items).to.equal(undefined);
  }
}

export const permitJobRule = {
  id: 'permit_rule_id',
  target: {
    resources: [
      {
        id: 'urn:restorecommerce:acs:names:model:entity',
        value: 'urn:restorecommerce:acs:model:job.Job'
      }
    ],
    subjects: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }
    ]
  },
  effect: Effect.PERMIT,
};

export const denyJobRule = {
  id: 'permit_rule_id',
  target: {
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:job.Job' }],
    subjects: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: Effect.DENY,
};

export const jobPolicySetRQ: PolicySetRQResponse = {
  policy_sets: [
    {
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'job_test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'job_test_policy_id',
          target: {
            actions: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:job.Job'
            }],
            subjects: []
          },
          rules: [],
          has_rules: true
        }]
    }
  ]
};

export interface serverRule {
  method: string,
  input: any,
  output: any
}
