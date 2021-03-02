import { JobId, JobOptions } from 'bull';
import { Subject } from '@restorecommerce/acs-client';

export enum Priority {
  NORMAL = 0,
  LOW = 10,
  MEDIUM = -5,
  HIGH = -10,
  CRITICAL = -15,
}

export enum Backoffs {
  FIXED = 'FIXED',
  EXPONENTIAL = 'EXPONENTIAL'
}

export interface FilterOpts {
  id: number | string;
  type?: string;
  data?: Data;
  opts?: JobOptions;
  name?: string;
}

export interface KafkaOpts {
  id: number | string;
  type?: string;
  data?: Data;
  options?: JobOptions;
  when?: string;
}


export interface Data {
  payload?: any;
  meta?: any;
  timezone?: string;
  subject_id?: string;
}

export interface JobFailedType {
  id: number | string;
  error?: string;
  schedule_type?: string;
  type?: string;
}

export interface JobDoneType {
  id: number | string;
  delete_scheduled?: boolean;
  schedule_type?: string;
  type?: string;
}

export interface JobType {
  id: number | string;
  type?: string;
  name?: string;
  data?: Data;
  when?: string;
  options?: JobOptions;
  opts?: JobOptions;
}

export interface NewJob {
  type: string;
  options: JobOptions;
  when?: string;
  data: Data;
  id?: string; // mapped to jobId of bull
}

export interface CreateCall {
  request: {
    items: NewJob[];
    subject?: Subject;
  };
}

export interface UpdateJob extends NewJob {
  id: string;
}

export interface UpdateCall {
  request: {
    items: UpdateJob[];
    subject?: Subject;
  };
}

export interface ReadCall {
  request?: {
    filter?: {
      job_ids?: JobId[];
      type?: string;
    };
    sort?: SortOrder;
    subject?: Subject;
  };
}

export interface DeleteCall {
  request: {
    ids?: JobId[];
    subject?: Subject;
    collection?: boolean;
  };
}

export interface GRPCResult {
  items: any[];
  total_count: number;
}

export interface JobService {
  create(call: CreateCall, context: any): Promise<any>;
  update(call: UpdateCall, context: any): any;
  read(call: ReadCall, context: any): any;
  delete(call: DeleteCall, context: any): any;
}

export enum SortOrder {
  ASCENDING = 'ASCENDING',
  DESCENDING = 'DESCENDING',
}
