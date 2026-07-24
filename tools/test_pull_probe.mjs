import assert from 'node:assert/strict';
import {
  DEFAULT_POST_BOMB_SEED,
  PullTracker,
  parseSeed,
  rngAdvance,
  rollDistance,
} from '../docs/js/pull-probe-core.js';

assert.equal(parseSeed('0x4D1DC240'), DEFAULT_POST_BOMB_SEED);
assert.equal(parseSeed('not a seed'), null);
let seed = DEFAULT_POST_BOMB_SEED;
for (let i = 0; i < 2301; i++) seed = rngAdvance(seed);
assert.equal(rollDistance(DEFAULT_POST_BOMB_SEED, seed), 2301);

const tracker = new PullTracker(DEFAULT_POST_BOMB_SEED);
tracker.consume({ frame: 100, seed: DEFAULT_POST_BOMB_SEED, targets: 10,
  actionState: 14, actionFrame: 1 });
const event = tracker.consume({ frame: 101, seed, targets: 6,
  actionState: 352, actionFrame: 1 });
assert.equal(event.attempt, 1);
assert.equal(event.pull, 1);
assert.equal(event.distance, 2301);

// A save-state rewind must begin a clean attempt and reset pull numbering.
tracker.consume({ frame: 50, seed: DEFAULT_POST_BOMB_SEED, targets: 0,
  actionState: 14, actionFrame: 1 });
tracker.consume({ frame: 100, seed: DEFAULT_POST_BOMB_SEED, targets: 10,
  actionState: 14, actionFrame: 1 });
const retried = tracker.consume({ frame: 101, seed, targets: 6,
  actionState: 352, actionFrame: 1 });
assert.equal(retried.attempt, 2);
assert.equal(retried.pull, 1);

console.log('pull probe: OK');
