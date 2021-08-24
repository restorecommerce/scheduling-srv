import { unmarshallProtobufAny } from '../lib/schedulingService';
import * as should from 'should';
import { Priority } from '../lib/types';
import { createMockServer } from 'grpc-mock';

export function validateScheduledJob(job: any, expectedSchedule: string): void {
  should.exist(job.data);
  should.exist(job.data.payload);
  const payload = unmarshallProtobufAny(job.data.payload);
  should.exist(payload.testValue);
  payload.testValue.should.equal('test-value');
  should.exist(job.id);
  should.exist(job.type);
  job.type.should.equal('test-job');
  should.exist(job.schedule_type);
  job.schedule_type.should.equal(expectedSchedule);
}

export function validateJobDonePayload(job: any): void {
  if (job && job.result) {
    should.exist(job.result);
    const payload = unmarshallProtobufAny(job.result);
    payload.testValue.should.equal('test-value');
  }
}

export function validateJob(job: any): void {
  should.exist(job);
  const payload = unmarshallProtobufAny(job.data.payload);
  should.exist(payload.testValue);
  payload.testValue.should.equal('test-value');
  should.exist(job.id);
  should.exist(job.type);
  job.type.should.equal('test-job');
  should.exist(job.options.priority);
  Priority.should.hasOwnProperty(job.options.priority);
  should.exist(job.options.attempts);
  job.options.attempts.should.equal(1);
}

export function payloadShouldBeEmpty(result: any): void {
  should.exist(result);
  should.exist(result.items);
  result.items.should.be.length(0);
}

export const permitJobRule = {
  id: 'permit_rule_id',
  target: {
    action: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:job.Job' }],
    subject: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: 'PERMIT'
};

export const denyJobRule = {
  id: 'permit_rule_id',
  target: {
    action: [],
    resources: [{ id: 'urn:restorecommerce:acs:names:model:entity', value: 'urn:restorecommerce:acs:model:job.Job' }],
    subject: [
      {
        id: 'urn:restorecommerce:acs:names:role',
        value: 'admin-r-id'
      },
      {
        id: 'urn:restorecommerce:acs:names:roleScopingEntity',
        value: 'urn:restorecommerce:acs:model:organization.Organization'
      }]
  },
  effect: 'DENY'
};

export const jobPolicySetRQ = {
  policy_sets:
    [{
      combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
      id: 'job_test_policy_set_id',
      policies: [
        {
          combining_algorithm: 'urn:oasis:names:tc:xacml:3.0:rule-combining-algorithm:permit-overrides',
          id: 'job_test_policy_id',
          target: {
            action: [],
            resources: [{
              id: 'urn:restorecommerce:acs:names:model:entity',
              value: 'urn:restorecommerce:acs:model:job.Job'
            }],
            subject: []
          }, effect: '',
          rules: [],
          has_rules: true
        }]
    }]
};

export interface serverRule {
  method: string,
  input: any,
  output: any
}

export const startGrpcMockServer = async (rules: serverRule[], logger): Promise<any> => {
  // Create a mock ACS server to expose isAllowed and whatIsAllowed
  const mockServer = createMockServer({
    protoPath: 'test/protos/io/restorecommerce/access_control.proto',
    packageName: 'io.restorecommerce.access_control',
    serviceName: 'Service',
    options: {
      keepCase: true
    },
    rules
  });
  mockServer.listen('0.0.0.0:50061');
  logger.info('ACS Server started on port 50061');
  return mockServer;
};

export const stopGrpcMockServer = async (mockServer, logger) => {
  await mockServer.close(() => {
    logger.info('Server closed successfully');
  });
};
