# scheduling-srv
<img src="http://img.shields.io/npm/v/%40restorecommerce%2Fscheduling%2Dsrv.svg?style=flat-square" alt="">[![Build Status][build]](https://travis-ci.org/restorecommerce/scheduling-srv?branch=master)[![Dependencies][depend]](https://david-dm.org/restorecommerce/scheduling-srv)[![Coverage Status][cover]](https://coveralls.io/github/restorecommerce/scheduling-srv?branch=master)

[version]: http://img.shields.io/npm/v/scheduling-srv.svg?style=flat-square
[build]: http://img.shields.io/travis/restorecommerce/scheduling-srv/master.svg?style=flat-square
[depend]: https://img.shields.io/david/restorecommerce/scheduling-srv.svg?style=flat-square
[cover]: http://img.shields.io/coveralls/restorecommerce/scheduling-srv/master.svg?style=flat-square

A generic microservice for scheduling jobs and emit them over [Apache Kafka](https://kafka.apache.org/). Job scheduling is implemented using [kue-scheduler](https://github.com/lykmapipo/kue-scheduler) which is a job scheduler utility for [kue](https://github.com/Automattic/kue), backed by [Redis](https://redis.io/). This service provides a [gRPC](https://grpc.io/docs/) interface for scheduling new jobs and modifying the existing jobs using CRUD operations. The scheduled and recurring jobs are persisted within an ArangoDB instance so that in case Redis goes down the jobs will be scheduled once the service starts up again.
The jobs emitted to Kafka can be consumed by other microservices. After processing the jobs an event is then emitted by the respetive microservices indicating job failure or completion.

## gRPC Interface

This microservice exposes the following gRPC endpoints for the Job resource.

### Job

`io.restorecommerce.job.Job`.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | string | required | Job resource ID |
| created | double | required | Date of the Job creation |
| modified | double | required | Date when Job was modified |
| creator | string | optional | User ID of the creator |
| name | string | required | Job name |
| unique | string | optional | A fixed job instance identifier; recurring jobs use this value as their instance ID in Redis if it is set |
| data | Data | optional | Payload data sent to the worker (structure is variable) |
| priority | `io.restorecommerce.job.Job.Priority` | optional | Job priority |
| attempts | number | optional | Amount of possible failing runs until a job fails |
| backoff | `io.restorecommerce.job.Backoff` | optional | Delay settings between failed job runs |
| parallel | number | optional | Maximum number of parallel jobs |
| interval | string | optional | Interval to run a job periodically which could be a cron entry. Ex: "0 0 5 * * *" to run a job everyday at 5AM (refer [kue-scheduler](https://github.com/lykmapipo/kue-scheduler) for more information)|
| when | string | optional | A date string, Job is run once at specific time. Ex: "Jan 15, 2018 10:30:00" |
| now | boolean | optional | If set to true job is run once immediately |

`io.restorecommerce.job.Data`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| timezone | string | optional | Timezone specification for job scheduling (ex: 'Europe/Amsterdam') |
| payload | [ ] `google.protobuf.Any` | optional | Generic data type for different job data structures (see [google.protobuf.Any](https://github.com/restorecommerce/protos/blob/master/google/protobuf/any.proto)) |

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

It exposes the below CRUD operations for creating or
modifying Job resource.

`io.restorecommerce.job.Service`

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Create | `io.restorecommerce.job.JobList` | `io.restorecommerce.job.JobList` | Create a list of Job resources |
| Read | `io.restorecommerce.resourcebase.ReadRequest` | `io.restorecommerce.job.JobList` | Read a list of Job resources |
| Update | `io.restorecommerce.job.JobList` | `io.restorecommerce.job.JobList` | Update a list of Job resources |
| Delete | `io.restorecommerce.resourcebase.DeleteRequest` | Empty | Delete a list of Job resources |
| Upsert | `io.restorecommerce.job.JobList` | `io.restorecommerce.job.JobList` | Create or Update a list of Job resources |

`io.restorecommerce.job.JobList`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| items | [ ]`io.restorecommerce.job.JobList` | required | List of Jobs |
| total_count | number | optional | number of Jobs |

For the detailed protobuf message structure of `io.restorecommerce.resourcebase.ReadRequest` and `io.restorecommerce.resourcebase.DeleteRequest` refer [resource-base-interface](https://github.com/restorecommerce/resource-base-interface).

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

For creating/modifying jobs through Kafka this service listens to events on topic `io.restorecommerce.jobs`. CRUD operations take the same arguments as the gRPC endpoints. Tracking a job's status is performed by listening to `jobDone` and `jobFailed` events, which are emitted by any microservice which processes a given job.

`io.restorecommerce.job.JobDone`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | number | required | Job instance ID in redis |
| schedule_type | string | required | Job type ex: `ONCE`, `RECURR` etc. |
| job_resource_id | string | required | Job reference ID in the database |
| job_unique_name | string | optinal | unique job name |

`io.restorecommerce.job.JobFailed`

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | number | required | Job instance ID in redis |
| schedule_type | string | required | Job type ex: `ONCE`, `RECURR` etc. |
| job_resource_id | string | required | Job reference ID in the database |
| job_unique_name | string | optinal | unique job name |

List of events emitted to Kafka by this microservice for below topics:
- `io.restorecommerce.jobs.resource`
  - jobsCreated
  - jobsModified
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
- implementation of a [command-interface](https://github.com/restorecommerce/chassis-srv/blob/master/command-interface.md) which
provides endpoints for retrieving the system status and resetting/restoring the system in case of failure. These endpoints can be called via gRPC or Kafka events (through the `io.restorecommerce.command` topic).
- database access, which is abstracted by the [resource-base-interface](https://github.com/restorecommerce/resource-base-interface)
- Redis cache management

## Usage

See [tests](test/).
