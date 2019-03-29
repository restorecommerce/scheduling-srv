# scheduling-srv
<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fscheduling%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/scheduling-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/scheduling-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/scheduling-srv?branch=master)

[version]: http://img.shields.io/npm/v/scheduling-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/scheduling-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/scheduling-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/scheduling-srv/master.svg?style=flat-square

A generic microservice for scheduling jobs and emitting them over [Apache Kafka](https://kafka.apache.org/). Job scheduling is implemented using [kue-scheduler](https://github.com/lykmapipo/kue-scheduler) which is a job scheduling extension of [kue](https://github.com/Automattic/kue) backed by [Redis](https://redis.io/). This service provides a [gRPC](https://grpc.io/docs/) interface for scheduling new jobs as well as manage the existing ones. Jobs can also be managed asynchronously using Kafka. 
Currently, three kinds of jobs can be scheduled:
- immediate jobs;
- one-time future jobs;
- recurring jobs.

Jobs emitted by this service to Kafka can be consumed by other microservices by listening to the `queuedJob` event. After processing the job an event should be emitted by the respective microservice indicating job failure or completion. A job is always deleted upon being receiving failure or completion data, unless it is a reccurring job.

## gRPC Interface

This microservice exposes the following gRPC endpoints for the Job resource.

### Job

`io.restorecommerce.job.Job`.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | Job resource ID |
| type | string | required | Arbitrary job type (e.g: 'daily_email_dispatcher'). |
| data | Data | optional | Job data to persist in Redis |
| priority | `io.restorecommerce.job.Job.Priority` | optional | Job priority |
| attempts | number | optional | Amount of possible failing runs until a job fails |
| backoff | `io.restorecommerce.job.Backoff` | optional | Delay settings between failed job runs |
| parallel | number | optional | Maximum number of parallel jobs |
| interval | string | optional | Interval to run a job periodically. It is possible to specify the interval in a cron format (e.g: "0 0 5 * * *") or a human-readable format (e.g: "2 minutes"), as specified on [kue-scheduler](https://github.com/lykmapipo/kue-scheduler). This should only be used in recurring jobs.
| when | string | optional | Used to define the exact time at which a single job instance is processed. Ex: "Jan 15, 2018 10:30:00". This should only be used in one-time jobs. |
| now | boolean | optional | If set to true job is run once immediately (job is not stored in Redis in this case). |

`io.restorecommerce.job.Data`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| timezone | string | optional | Timezone specification for job scheduling (ex: 'Europe/Amsterdam') |
| meta | [`io.restorecommerce.meta.Meta`](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/meta.proto) | required | Job resource meta info; only contains creation and modification timestamps |
| payload | [ ] [`google.protobuf.Any`](https://github.com/restorecommerce/protos/blob/master/google/protobuf/any.proto) | optional | Generic data type for job-specific data |

`io.restorecommerce.job.Job.Priority`

| Name | Number | Description |
| ---- | ------ | ----------- |
| NORMAL | 0 | normal priority, default value |
| LOW | 10 | low priority |
| MEDIUM | -5 | medium priority |
| HIGH | -10 | high priority |
| CRITICAL | -15 | critical priority |

`io.restorecommerce.job.Backoff`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| delay | number | required | Time until retry in milliseconds |
| type | `io.restorecommerce.job.Backoff.Type` | optional | Calucation of the delay for retries |

`io.restorecommerce.job.Backoff.Type`

| Name | Number | Description |
| ---- | ------ | ----------- |
| FIXED | 0 | Retry with the same delay |
| EXPONENTIAL | 1 | Exponential delay increase between retries |

#### CRUD Operations

`io.restorecommerce.job.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | `io.restorecommerce.job.JobList` | `io.restorecommerce.job.JobList` | Create a list of Job resources |
| Read | `io.restorecommerce.job.JobReadRequest` | `io.restorecommerce.job.JobList` | Read a list of Job resources |
| Update | `io.restorecommerce.job.JobList` | `io.restorecommerce.job.JobList` | Update a list of Job resources |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest` | [`google.protobuf.Empty`](https://github.com/restorecommerce/protos/blob/master/google/protobuf/empty.proto) | Delete a list of Job resources |


`io.restorecommerce.job.JobList`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| items | [ ]`io.restorecommerce.job.Job` | required | List of Jobs |
| total_count | number | optional | Number of Jobs |

Please note that the `update` operation literally just deletes an existing job and reschedules it with new data.

For the detailed protobuf message structure of `io.restorecommerce.job.ReadRequest` and `io.restorecommerce.job.DeleteRequest` refer [job.proto](https://github.com/restorecommerce/protos/blob/master/io/restorecommerce/job.proto).

## Kafka Events

This microservice subscribes to the following Kafka events by topic:
- `io.restorecommerce.jobs`
  - createJobs
  - modifyJobs
  - deleteJobs
  - jobDone
  - jobFailed
- `io.restorecommerce.command`
  - restoreCommand
  - resetCommand
  - healthCheckCommand
  - versionCommand

Jobs can be created, updated or deleted by issuing Kafka messages to topic `io.restorecommerce.jobs`. These operations are exposed with the same input as the gRPC endpoints (note that it is only possible to *read* a job through gRPC). 

`io.restorecommerce.job.ScheduledJob`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | number | required | Job instance ID in Redis |
| type | string | required | Arbitrary job type (e.g: 'daily_email_dispatcher'). |
| data | `io.restorecommerce.job.Data` | required | Arbitrary job type (e.g: 'daily_email_dispatcher'). |
| schedule_type | string | required | Job type ex: `ONCE`, `RECURR` etc. |

`io.restorecommerce.job.JobDone`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | number | required | Job instance ID in Redis |
| schedule_type | string | required | Job type ex: `ONCE`, `RECURR` etc. |

`io.restorecommerce.job.JobFailed`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | number | required | Job instance ID in redis |
| schedule_type | string | required | Job type ex: `ONCE`, `RECURR` etc. |
| error | string | required | Failure details. |

List of events emitted to Kafka by this microservice for below topics:
- `io.restorecommerce.jobs.resource`
  - jobsCreated
  - jobsDeleted
- io.restorecommerce.command
  - restoreResponse
  - resetResponse
  - healthCheckResponse
  - versionResponse

Events from the `io.restorecommerce.jobs.resource` topic are issued whenever a CRUD opertion is performed. They are useful for job rescheduling in case of Redis failure.

## Chassis Service

This service uses [chassis-srv](http://github.com/restorecommerce/chassis-srv), a base module for [restorecommerce](https://github.com/restorecommerce) microservices, in order to provide the following functionalities:
- exposure of all previously mentioned gRPC endpoints
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- a Redis database connection, which is used to store the offset values for Kafka topics at regular intervals and to store scheduled jobs

## Development

### Tests

See [tests](test/).

## Usage

### Development

- Install dependencies

```sh
npm install
```

- Build application

```sh
# compile the code
npm run build
```

- Run application and restart it on changes in the code

```sh
# Start scheduling-srv in dev mode
npm run dev
```

### Production

```sh
# compile the code
npm run build

# run compiled server
npm start
```