import * as _ from 'lodash';
import * as asyncjs from 'async';
import * as kue from 'kue-scheduler';

// (The MIT License)

// Copyright (c) 2011 lykmapipo && Contributors

// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the 'Software'), to deal in the
// Software without restriction, including without limitation the rights to use, copy, modify,
// merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all copies
// or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
// HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

function ensureUniqueJob(job: any, done: any): any {

  if (job && job.alreadyExist) {
    // check if job is complete or failed
    const isCompletedOrFailedJob =
      (job.state() === 'complete' ||
        job.state() === 'failed');
    const now = new Date();
    // assuming updated_at is in the past or now
    // updated_at is a built-in from kue.
    const timeSinceLastUpdate = now.getTime() - job.updated_at; // jshint ignore:line
    const arbitraryThreshold = job.data.ttl + (job.data.ttl / 2);
    const isStaleJob =
      (job.state() === 'active' &&
        timeSinceLastUpdate > arbitraryThreshold
      );
    if (isCompletedOrFailedJob || isStaleJob) {
      // resave job for next run
      //
      // NOTE!: We inactivate job to allow kue to queue the same job for next run.
      // This will ensure only a single job instance will be used for the next run.
      // This is the case for unique job behaviour.
      job.inactive();
      job.save(done);
    } else {
      done(null, job);
    }
  } else {
    done(null, job);
  }
}

/**
 * kue.Queue extension
 */
// export class Queue extends kue {
/**
 * Overrides Queue#schedule to include
 * 'unique' key saving in one-time jobs in waterfall
 *
 * @param when {Date | String}
 * @param job {kue.Job}
 * @param done {function(Error, kue.Job): any}
 */
export function schedule(when: any, job: any, done: any): any {
  // this refer to kue Queue instance context

  asyncjs.waterfall([
    function ensureInterval(next: any): any {
      if (!when && !(_.isString(when) || _.isDate(when))) {
        next(new Error('Missing Schedule Interval'));
      } else {
        next(null, when, job);
      }
    },

    function ensureJobInstance(when: any, job: any, next: any): any {
      if (!job && !(job instanceof kue.Job)) {
        next(new Error('Invalid Job Instance'));
      } else {
        next(null, when, job);
      }
    },

    function prepareJobDefinition(when: any, job: any, next: any): any {
      const jobDefinition = _.extend(job.toJSON(), {
        backoff: job._backoff
      });

      next(null, when, job, jobDefinition);
    },

    function computeDelay(when: any, job: any, jobDefinition: any, next: any): any {
      // when is date instance
      if (when instanceof Date) {
        next(null, jobDefinition, when);
      }

      // otherwise parse as date.js string
      else {
        this._parse(when, function (error: any, scheduledDate: any): any {
          next(error, jobDefinition, scheduledDate);
        });
      }
    }.bind(this),

    // set job delay
    function setDelay(jobDefinition: any, scheduledDate: any, next: any): any {
      next(
        null,
        _.merge({}, jobDefinition, {
          delay: scheduledDate,
          data: {
            schedule: 'ONCE'
          }
        })
      );
    },

    function buildJob(delayedJobDefinition: any, next: any): any {
      this._buildJob(delayedJobDefinition, next);
    }.bind(this),


    function saveJob(job: any, validations: any, next: any): any {
      job.save((error, existJob) => {
        next(error, existJob || job);
      });
    },

    function ensureSingleUniqueJob(job: any, next: any): any {
      ensureUniqueJob(job, next);
    },
    function saveUniqueJob(job: any, next: any): any {
      // if a unique name is specified, save it with the job details
      if (job.data && job.data.unique) {
        const jobDataKey = this._getJobDataKey(job.data.unique);
        this._saveJobData(jobDataKey, job, (error) => {
          next(error, job);
        });
      } else {
        next(null, job);
      }
    }.bind(this)

  ], function (error: any, job: any): any {
    // fire schedule error event
    if (error) {
      this.emit('schedule error', error);
    }

    // fire already schedule event
    else if (job.alreadyExist) {
      this.emit('already scheduled', job);
    }

    // fire schedule success event
    else {
      this.emit('schedule success', job);
    }

    // invoke callback if provided
    if (done && _.isFunction(done)) {
      done(error, job);
    }

  }.bind(this));
}
