import { unmarshallProtobufAny } from '../schedulingService';
import * as should from 'should';
import {Priority} from "../types";

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

export function validateJobResource(job: any): void {
  should.exist(job.data);
  should.exist(job.data.payload);
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

export function shouldBeEmpty(result: any): void {
  should.exist(result);
  if (result.data) {
    should.exist(result.data);
    should.exist(result.data.items);
    result.data.items.should.be.length(0);
  } else {
    should.exist(result.items);
    result.items.should.be.length(0);
  }
}

