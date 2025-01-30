import { unmarshallProtobufAny } from '../src/utilts.js';
import should from 'should';
import { Priority } from '../src/types.js';
import { Logger } from 'winston';
import { PolicySetRQResponse } from '@restorecommerce/acs-client';
import { Effect } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/rule.js';
import { createServiceConfig } from '@restorecommerce/service-config';

export const cfg = createServiceConfig(process.cwd() + '/test');

export function validateScheduledJob(job: any, expectedSchedule: string, logger: Logger): void {
  should.exist(job.data);
  should.exist(job.data.payload);
  const payload = unmarshallProtobufAny(job.data.payload, logger);
  should.exist(payload.testValue);
  payload.testValue.should.equal('test-value');
  should.exist(job.id);
  should.exist(job.type);
  job.type.should.equal('test-job');
  // should.exist(job.schedule_type);
  // job.schedule_type.should.equal(expectedSchedule);
}

export function validateJobDonePayload(job: any, logger: Logger): void {
  if (job && job.result) {
    should.exist(job.result);
    const payload = unmarshallProtobufAny(job.result, logger);
    payload.testValue.should.equal('test-value');
  }
}

export function validateJob(job: any, logger: Logger): void {
  should.exist(job);
  const payload = unmarshallProtobufAny(job.data.payload, logger);
  should.exist(payload.testValue);
  payload.testValue.should.equal('test-value');
  should.exist(job.id);
  should.exist(job.type);
  job.type.should.equal('test-job');
  job.queue_name.should.equal('test-job');
  should.exist(job.options.priority);
  Priority.should.hasOwnProperty(job.options.priority);
  should.exist(job.options.attempts);
  job.options.attempts.should.equal(1);
}

export function payloadShouldBeEmpty(result: any, emptyArray: boolean = true): void {
  should.exist(result);
  if (emptyArray) {
    should.exist(result.items);
    result.items.should.be.length(0);
  } else {
    // since grpc read does not return empty elements after making fields optional
    should.not.exist(result.items);
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
