/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//
// Run a pre-validated and pre-prepared test script across a number of
// (local) workers.
//

'use strict';

const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const fork = require('child_process').fork;

const debug = require('debug')('artillery:runner');
const L = require('lodash');

const stats = require('artillery-core').stats;
const divideWork = require('./dist');

module.exports = createRunner;

function createRunner(script, payload, opts) {
  const runner = new Runner(script, payload, opts);
  return runner;
}

function Runner(script, payload, opts) {
  this._script = script;
  this._payload = payload;
  this._opts = opts;
  this._workers = {};

  this.events = new EventEmitter();

  this._intermediates = [];
  this._allIntermediates = [];

  this._currentPhase = -1;

  return this;
}

Runner.prototype.run = function run() {
  //
  // Create worker scripts (distribute the work):
  //
  let numWorkers = process.env.ARTILLERY_WORKERS || 1 || os.cpus().length;
  let workerScripts = divideWork(this._script, numWorkers);
  // Overwrite statsInterval for workers:
  L.each(workerScripts, function(s) {
    s.config.statsInterval = 1;
  });

  debug(JSON.stringify(workerScripts, null, 4));

  //
  // Create workers:
  //
  L.each(workerScripts, (script) => {
    let workerProcess = fork(path.join(__dirname, 'worker.js'));
    this._workers[workerProcess.pid] = {
      proc: workerProcess,
      isDone: false
    };
    workerProcess.on('message', this._onWorkerMessage.bind(this));
    workerProcess.send({
      command: 'run',
      opts: {
        script: script,
        payload: this._payload, // FIXME: Inefficient with large payloads
        options: this._opts
      }
    });
  });

  // TODO: Use nanotimer
  setInterval(
    this._sendStats.bind(this),
    this._script.config.statsInterval * 1000).unref();
  return this;
};

Runner.prototype._sendStats = function() {
  // Calculate average concurrency:
  // We are averaging and overwriting the value in the report ourselves because
  // combine() presumes that stats objects come from different workers, but
  // we will have multiple intermediate objects from the same worker.

  // Calculate max concurrency (sampled at one second resolution):
  let maxWorkerConcurrencies = L.reduce(
    this._intermediates,
    function(acc, el) {
      const pid = el[0];
      const intermediate = el[1];
      if (typeof acc[pid] !== 'undefined') {
        acc[pid] = L.max([acc[pid], intermediate._concurrency]);
      } else {
        acc[pid] = intermediate._concurrency;
      }
      return acc;
    }, {});

  debug('max worker concurrency: %j', maxWorkerConcurrencies);

  let averageConcurrency = stats.round(
    L.sum(
      L.map(maxWorkerConcurrencies, function(v) { return v; })),
    1);

  let combined = stats.combine(
    L.map(this._intermediates, function(el) { return el[1]; }));

  combined._concurrency = averageConcurrency;

  this.events.emit('stats', combined);
  this._intermediates = [];
};

Runner.prototype._onWorkerMessage = function _onWorkerMessage(message) {
  if (message.event === 'phaseStarted') {
    if (message.phase.index > this._currentPhase) {
      this.events.emit('phaseStarted', message.phase);
      this._currentPhase = message.phase.index;
    }
  }

  if (message.event === 'phaseCompleted') {
  }

  if (message.event === 'stats') {
    this._intermediates.push([message.pid, message.stats]);
    this._allIntermediates.push(message.stats);
  }

  if (message.event === 'done') {
    let worker = this._workers[message.pid];
    worker.isDone = true;
    worker.proc.kill();

    if (this._activeWorkerCount() === 0) {
      this._sendStats();
      this.events.emit('done', stats.combine(this._allIntermediates));
    }
  }
};

Runner.prototype._activeWorkerCount = function _activeWorkerCount() {
  var pids = Object.keys(this._workers);
  var count = pids.length;
  pids.forEach((pid) => {
    if (this._workers[pid].isDone) {
      count--;
    }
  });
  return count;
};
