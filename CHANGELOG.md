
### 1.2.7 (November 26th, 2023)

- removed deprecated method in chassis-srv (collection.load)

## 1.2.6 (November 25th, 2023)

- added created_by and modified_by fields to store to redis job meta 

## 1.2.5 (November 25th, 2023)

- updated all dependencies (added created_by field to meta and client_id to tokens)

## 1.2.4 (November 23d, 2023)

- fix for storing string values to redis

## 1.2.3 (November 23d, 2023)

- added queue name to job response

## 1.2.2 (November 22nd, 2023)

- added support to specify queue_name when creating the job

## 1.2.1 (November 21st, 2023)

- up deps (changed expires_in to date timestamp)

## 1.2.0 (October 7th, 2023)

- up node and deps

## 1.1.2 (September 5th, 2023)

- fix external jobs dir when no env var is provided
- use runWorker from npm package scs-jobs

## 1.1.1 (September 4th, 2023)

- up dependencies

## 1.1.0 (September 21st, 2023)

- up protos (to set all fields optionals)

## 1.0.3 (July 28th, 2023)

- bump version to trigger build

## 1.0.2 (July 28th, 2023)

- refactor owner and role association attributes
- up build to use latest Dockerfile
- refactor for handling meta created / modified time stamp field handling
- up deps

## 1.0.1 (June 20th, 2023)

- up all deps

## 1.0.0 (April 21st, 2023)

- migrate from bull to bull-mq
- up all deps

## 0.3.2 (October 26th, 2022)

- move to full typed client and server, full text search
- up all deps

## 0.3.1 (July 8th, 2022)

- up deps

## 0.3.0 (June 30th, 2022)

- up deps
- migrated bullboard to @bullboard

## 0.2.18 (March 1st, 2022)

- fixed redis url for bull

## 0.2.17 (February 18th, 2022)

- updated chassis-srv (includes fix for offset store config)

## 0.2.16 (February 14th, 2022)

- updated redis url

## 0.2.15 (February 14th, 2022)

- updated dependencies and migrated from ioredis to redis

## 0.2.14 (December 22nd, 2021)

- fix default import to require

## 0.2.13 (December 22nd, 2021)

- removed importHelpers flag from tsconfig

## 0.2.12 (December 22nd, 2021)

- fixed default import

## 0.2.11 (December 22nd, 2021)

- up RC dependencies and added no floating promises rule
- up ts config

## 0.2.10 (December 15th, 2021)

- up acs-client and other dependencies

## 0.2.9 (December 13th, 2021)

- added null check for context object

## 0.2.8 (December 10th, 2021)

- fix custom arguments

## 0.2.7 (December 10th, 2021)

- updated acs-client and restructured checkAccessRequest accordingly
- updated logger and other dependencies

## 0.2.6 (October 18th, 2021)

- fix to pass meta owner information for update / upsert

## 0.2.5 (October 15th, 2021)

- fix filter by ownership

## 0.2.4 (October 14th, 2021)

- added payload check before creating meta data

## 0.2.3 (October 7th, 2021)

- up protos and acs-client

## 0.2.2 (September 21st, 2021)

- up RC dependencies

## 0.2.1 (September 13th, 2021)

- up dependencies

## 0.2.0 (August 24th, 2021)

- updated grpc-client
- migraged kafka-client to kafkajs
- chassis-srv using the latest grpc-js and protobufdef loader
- filter changes (removed google.protobuf.struct completely and defined nested proto structure)
- added status object to each item and also overall operation_status

## 0.1.24 (August 18th, 2021)

- removed default clean up of queues `queue.clean(0)` from jobDone / jobFailed listener and added setup clean interval to remove completed / failed jobs

## 0.1.23 (August 9th, 2021)

- removed jobcall back done and replaced with job.moveToCompleted and updated bull

## 0.1.22 (July 8th, 2021)

- enabled to support advanced settings in queue configuration
- removed the manual `deleteJobInstance` since we have support for `removeOnComplete` in job options
- updated bull 3.22.10 to 3.22.11

## 0.1.21 (July 7th, 2021)

- improved logging on event listener and added catch block for deleting job
- updated bull 3.21.1 to 3.22.10

## 0.1.20 (June 28th, 2021)

- updated node version to 16.3
- updated logger and protos

## 0.1.19 (April 13th, 2021)

- updated Docker image Node version to 14.15.5
for both docker files

## 0.1.18 (March 19th, 2021)

- migrated from redis to ioredis module
- updated dependencies.

## 0.1.17 (March 11th, 2021)

- updated dependencies.

## 0.1.16 (March 4th, 2021)

- fix for create, update, upsert and delete to expose job ID
- map job id to repeatable key for recurring jobs
- upgraded dependencies
- removed flush stalled jobs from external-jobs

## 0.1.15 (February 24th, 2021)

- upgraded logger and service-config

## 0.1.14 (February 23rd, 2021)

- downgraded node version

## 0.1.13 (February 23rd, 2021)

- fix lastRuntime error (on redis)
- updgaed deps, node and npm

## 0.1.12 (January 14th, 2021)

- up dependencies (bull board mainly)

## 0.1.11 (December 4th, 2020)

- up acs-client (unauthenticated fix), protos (last_login updated on token)

## 0.1.10 (December 2nd, 2020)

- fix docker image permissions

### 0.1.9 (November 19th, 2020)

- changes to remove subject-id and pass only token
- updated dependencies

### 0.1.8 (October 19th, 2020)

- updated chassis-srv
- add acs-srv readiness check
- updated acs-client

### 0.1.7 (October 15th, 2020)

- add new grpc healthcheck with readiness probe
- listen on 0.0.0.0 for grpc port
- up acs-client, protos and deps

### 0.1.6 (October 3rd, 2020)

- updated acs-client includes the fix for validation of subject id and token

### 0.1.5 (October 3rd, 2020)

- updated acs-client and restructured protos

### 0.1.4 (September 9th, 2020)

- updated acs-client and protos
- fix not to read subject from redis

### 0.1.3 (September 8th, 2020)

- added a default queue with default configuration.
- added option to configure additional queues with concurrency.
- added option to configure queues with rate limiting (optional).
- added option to enable/disable the rescheduling of missed jobs for
 recurring jobs.

### 0.1.2 (August 27th, 2020)

- healthcheck fix, updated dependencies

### 0.1.1 (August 18th, 2020)

- updated logger and node version

### 0.1.0 (July 29th, 2020)

- initial release
