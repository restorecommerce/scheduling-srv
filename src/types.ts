import { JobOptions } from 'bull';
// import { Subject } from '@restorecommerce/acs-client';

import { Data } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/job';

export enum Priority {
  NORMAL = 0,
  LOW = 10,
  MEDIUM = -5,
  HIGH = -10,
  CRITICAL = -15,
}

// export enum Backoffs {
//   FIXED = 'FIXED',
//   EXPONENTIAL = 'EXPONENTIAL'
// }

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


// export interface Data {
//   payload?: any;
//   meta?: any;
//   timezone?: string;
//   subject_id?: string;
// }

// export interface JobFailedType {
//   id: number | string;
//   error?: string;
//   schedule_type?: string;
//   type?: string;
// }

// export interface JobDoneType {
//   id: number | string;
//   delete_scheduled?: boolean;
//   schedule_type?: string;
//   type?: string;
// }

export interface JobType {
  id: number | string;
  type?: string;
  name?: string;
  data?: Data;
  when?: string;
  options?: JobOptions;
  opts?: JobOptions;
}

// export interface ExtendedJobOptions extends JobOptions {
//   delay?: number;
// }

// export interface BullJob extends Job {
//   name?: string;
//   options?: ExtendedJobOptions;
//   opts?: ExtendedJobOptions;
// }

export interface NewJob {
  type: string;
  options: JobOptions;
  when?: string;
  data: Data;
  id?: string; // mapped to jobId of bull
}

// export interface CreateCall {
//   request: {
//     items: NewJob[];
//     subject?: Subject;
//   };
// }

// export interface UpdateJob extends NewJob {
//   id: string;
// }

// export interface UpdateCall {
//   request: {
//     items: UpdateJob[];
//     subject?: Subject;
//   };
// }

// export interface ReadCall {
//   request?: {
//     filter?: {
//       job_ids?: JobId[];
//       type?: string;
//     };
//     sort?: SortOrder;
//     subject?: Subject;
//   };
// }

// export interface DeleteCall {
//   request: {
//     ids?: JobId[];
//     subject?: Subject;
//     collection?: boolean;
//   };
// }

// export interface Status {
//   id: string;
//   code: number;
//   message: string;
// };

// export interface JobResponse {
//   payload?: JobType;
//   status?: Status;
// }

// export interface OperationStatus {
//   code: number;
//   message: string;
// };

// export interface JobListResponse {
//   items?: JobResponse[];
//   total_count?: number;
//   operation_status: OperationStatus;
// }

// export interface DeleteResponse {
//   status?: Status[];
//   operation_status?: OperationStatus;
// }

// export interface JobService {
//   create(call: CreateCall, context: any): Promise<JobListResponse>;
//   update(call: UpdateCall, context: any): Promise<JobListResponse>;
//   read(call: ReadCall, context: any): Promise<JobListResponse>;
//   delete(call: DeleteCall, context: any): Promise<DeleteResponse>;
// }

export enum SortOrder {
  ASCENDING = 'ASCENDING',
  DESCENDING = 'DESCENDING',
}
