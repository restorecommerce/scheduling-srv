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
