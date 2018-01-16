# Protocol Documentation
<a name="top"/>

## Table of Contents
* [job.proto](#job.proto)
 * [Backoff](#io.restorecommerce.job.Backoff)
 * [Deleted](#io.restorecommerce.job.Deleted)
 * [Job](#io.restorecommerce.job.Job)
 * [JobDone](#io.restorecommerce.job.JobDone)
 * [JobFailed](#io.restorecommerce.job.JobFailed)
 * [JobList](#io.restorecommerce.job.JobList)
 * [ScheduledJob](#io.restorecommerce.job.ScheduledJob)
 * [Backoff.Type](#io.restorecommerce.job.Backoff.Type)
 * [Job.Priority](#io.restorecommerce.job.Job.Priority)
 * [Scheduling](#io.restorecommerce.job.Scheduling)
* [Scalar Value Types](#scalar-value-types)

<a name="job.proto"/>
<p align="right"><a href="#top">Top</a></p>

## job.proto



<a name="io.restorecommerce.job.Backoff"/>
### Backoff
Delay between retries.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| delay | [double](#double) | optional | Time until retry in milliseconds |
| type | [Backoff.Type](#io.restorecommerce.job.Backoff.Type) | optional | Calculation of the delay |


<a name="io.restorecommerce.job.Deleted"/>
### Deleted
A Kafka event.
Send when a job resource got deleted.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | [string](#string) | optional |  |


<a name="io.restorecommerce.job.Job"/>
### Job
A Job resource

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | [string](#string) | optional | Job resource ID |
| created | [double](#double) | optional | Date of the Job creation |
| modified | [double](#double) | optional | Last time the Job was modified |
| creator | [string](#string) | optional | User ID of the creator |
| name | [string](#string) | optional | Job name, indicates the job type |
| unique | [string](#string) | optional | Only one job at a time is allowed when set |
| data | [Any](#google.protobuf.Any) | optional | Payload send to the worker. |
| priority | [Job.Priority](#io.restorecommerce.job.Job.Priority) | optional | Job priority |
| attempts | [uint32](#uint32) | optional | Amount of possible failing runs until job fails |
| backoff | [Backoff](#io.restorecommerce.job.Backoff) | optional | Delay settings between failed job runs |
| parallel | [uint32](#uint32) | optional | Number of parallel jobs |
| interval | [string](#string) | optional | A job is run periodically. Example: &quot;2 seconds&quot; |
| when | [string](#string) | optional | Job is run once at a specific time. Example: &quot;2 seconds from now&quot; |
| now | [bool](#bool) | optional | When true, the job is run once immediately |


<a name="io.restorecommerce.job.JobDone"/>
### JobDone
A finished scheduled Job event from the Job Service.
Emitted to Kafka by the job service and retrieved by the scheduling service.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | [string](#string) | optional | Job instance ID |


<a name="io.restorecommerce.job.JobFailed"/>
### JobFailed
A failed scheduled Job event from the Job Service.
Emitted to Kafka by the job service and retrieved by the scheduling service.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | [string](#string) | optional | Job instance ID |
| error | [string](#string) | optional | Error message |


<a name="io.restorecommerce.job.JobList"/>
### JobList
A list of jobs.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| items | [Job](#io.restorecommerce.job.Job) | repeated |  |


<a name="io.restorecommerce.job.ScheduledJob"/>
### ScheduledJob
A scheduled Job for the Job Service.
Emitted to Kafka by the scheduling service and retrieved by the job service.

| Field | Type | Label | Description |
| ----- | ---- | ----- | ----------- |
| id | [string](#string) | optional | Job instance ID |
| name | [string](#string) | optional | Job name, indicates the job type |
| data | [Any](#google.protobuf.Any) | optional | Payload |



<a name="io.restorecommerce.job.Backoff.Type"/>
### Backoff.Type


| Name | Number | Description |
| ---- | ------ | ----------- |
| FIXED | 0 | Retry with the same delay |
| EXPONENTIAL | 1 | Exponential delay increase between retries |

<a name="io.restorecommerce.job.Job.Priority"/>
### Job.Priority
Job Priority

| Name | Number | Description |
| ---- | ------ | ----------- |
| NORMAL | 0 |  |
| LOW | 10 |  |
| MEDIUM | -5 |  |
| HIGH | -10 |  |
| CRITICAL | -15 |  |



<a name="io.restorecommerce.job.Scheduling"/>
### Scheduling
The microservice for scheduling jobs.
Provides CRUD operations.

| Method Name | Request Type | Response Type | Description |
| ----------- | ------------ | ------------- | ------------|
| Get | [GetRequest](#io.restorecommerce.apiresource.GetRequest) | [JobList](#io.restorecommerce.job.JobList) |  |
| Post | [JobList](#io.restorecommerce.job.JobList) | [JobList](#io.restorecommerce.job.JobList) |  |
| Delete | [DeleteRequest](#io.restorecommerce.apiresource.DeleteRequest) | [Empty](#google.protobuf.Empty) |  |
| Patch | [JobList](#io.restorecommerce.job.JobList) | [JobList](#io.restorecommerce.job.JobList) |  |
| Put | [JobList](#io.restorecommerce.job.JobList) | [JobList](#io.restorecommerce.job.JobList) |  |



<a name="scalar-value-types"/>
## Scalar Value Types

| .proto Type | Notes | C++ Type | Java Type | Python Type |
| ----------- | ----- | -------- | --------- | ----------- |
| <a name="double"/> double |  | double | double | float |
| <a name="float"/> float |  | float | float | float |
| <a name="int32"/> int32 | Uses variable-length encoding. Inefficient for encoding negative numbers – if your field is likely to have negative values, use sint32 instead. | int32 | int | int |
| <a name="int64"/> int64 | Uses variable-length encoding. Inefficient for encoding negative numbers – if your field is likely to have negative values, use sint64 instead. | int64 | long | int/long |
| <a name="uint32"/> uint32 | Uses variable-length encoding. | uint32 | int | int/long |
| <a name="uint64"/> uint64 | Uses variable-length encoding. | uint64 | long | int/long |
| <a name="sint32"/> sint32 | Uses variable-length encoding. Signed int value. These more efficiently encode negative numbers than regular int32s. | int32 | int | int |
| <a name="sint64"/> sint64 | Uses variable-length encoding. Signed int value. These more efficiently encode negative numbers than regular int64s. | int64 | long | int/long |
| <a name="fixed32"/> fixed32 | Always four bytes. More efficient than uint32 if values are often greater than 2^28. | uint32 | int | int |
| <a name="fixed64"/> fixed64 | Always eight bytes. More efficient than uint64 if values are often greater than 2^56. | uint64 | long | int/long |
| <a name="sfixed32"/> sfixed32 | Always four bytes. | int32 | int | int |
| <a name="sfixed64"/> sfixed64 | Always eight bytes. | int64 | long | int/long |
| <a name="bool"/> bool |  | bool | boolean | boolean |
| <a name="string"/> string | A string must always contain UTF-8 encoded or 7-bit ASCII text. | string | String | str/unicode |
| <a name="bytes"/> bytes | May contain any arbitrary sequence of bytes. | string | ByteString | str |
