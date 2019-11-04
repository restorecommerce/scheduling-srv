import {JobId, JobOptions} from "bull";

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

export interface NewJob {
  type: string;
  options: JobOptions;
  when?: string;
  volatile?: boolean;
  data: {
    payload: any;
    meta?: any;
    timezone?: string;
  };
}

export interface CreateCall {
  request: {
    items: NewJob[];
  };
}

export interface UpdateJob extends NewJob {
  id: string;
}

export interface UpdateCall {
  request: {
    items: UpdateJob[];
  };
}

export interface ReadCall {
  request?: {
    filter?: {
      job_ids?: JobId[];
      type?: string;
    };
    sort?: SortOrder;
  };
}

export interface DeleteCall {
  request: {
    ids: JobId[];
  } | {
    collection: boolean;
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
