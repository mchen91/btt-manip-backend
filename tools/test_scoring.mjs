#!/usr/bin/env node
// Verification for the scored targetprey candidate search (docs/js/event.js
// findScoredCandidates) and the manip-time helper (docs/js/rolls.js
// manipTimeFrames), against independent brute-force simulation of the LCG.
//
// Usage: node tools/test_scoring.mjs [TRIALS]   (default 200)

import { rngAdv, rngInt } from '../docs/js/util.js';
import { findScoredCandidates } from '../docs/js/event.js';
import {
  CURRENT_PULL_MODEL,
  integerNormalProbability,
  pullSearchRanges,
  scorePullOptions,
} from '../docs/js/pull-model.js';
import { manipTimeFrames, buildActionSequence, PORT_ADVANCE_THRESHOLD } from '../docs/js/rolls.js';

const TRIALS = Number(process.argv[2] || 200);

let failures = 0;
function fail(msg) {
  failures++;
  console.error('FAIL: ' + msg);
}

function advance(seed, n) {
  for (let i = 0; i < n; i++) seed = rngAdv(seed);
  return seed;
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

// Independent oracle: does `seed` yield stage-load(12) + bomb pull?
// Returns the post-bomb seed, or null.
function bombAt(seed) {
  let s = advance(seed, 12);
  s = rngAdv(s);
  if (rngInt(s, 128) !== 0) return null;
  s = rngAdv(s);
  const t = rngInt(s, 6);
  return t <= 1 ? s : null;
}

// Independent oracle: does the next pull from `seed` yield a sword?
function swordAt(seed) {
  let s = rngAdv(seed);
  if (rngInt(s, 128) !== 0) return false;
  s = rngAdv(s);
  return rngInt(s, 6) === 5;
}

// Independent RNG oracle: all sword offsets in each modeled pull window.
function scanWindows(postBomb, model) {
  const offsetsByPull = {};
  for (const range of pullSearchRanges(model)) {
    let s = advance(postBomb, range.lo);
    const offsets = [];
    for (let off = range.lo; off <= range.hi; off++) {
      if (swordAt(s)) offsets.push(off);
      s = rngAdv(s);
    }
    offsetsByPull[range.id] = offsets;
  }
  return offsetsByPull;
}

/* --- findScoredCandidates ------------------------------------------- */

let totalCandidates = 0;
let multiSword = 0;

for (let trial = 0; trial < TRIALS; trial++) {
  const start = randomSeed();
  const candidates = findScoredCandidates(start, {
    model: CURRENT_PULL_MODEL,
    horizon: PORT_ADVANCE_THRESHOLD,
    maxCandidates: 6,
  });

  if (candidates.length === 0) {
    fail(`trial ${trial}: no candidates from 0x${start.toString(16)}`);
    continue;
  }
  totalCandidates += candidates.length;

  let prevInterval = -1;
  for (const c of candidates) {
    if (c.interval <= prevInterval) fail(`trial ${trial}: intervals not ascending`);
    prevInterval = c.interval;

    if (advance(start, c.interval) !== c.seed) {
      fail(`trial ${trial}: interval ${c.interval} does not reach candidate seed`);
    }
    const pb = bombAt(c.seed);
    if (pb === null) fail(`trial ${trial}: candidate at ${c.interval} is not a bomb`);
    else if (pb !== c.postBombSeed) fail(`trial ${trial}: postBombSeed mismatch`);

    const oracleOffsets = scanWindows(c.postBombSeed, CURRENT_PULL_MODEL);
    const oracleScore = scorePullOptions(oracleOffsets, CURRENT_PULL_MODEL);
    for (const pull of c.pulls) {
      if (JSON.stringify(oracleOffsets[pull.id]) !== JSON.stringify(pull.offsets)) {
        fail(`trial ${trial}: ${pull.id} offsets mismatch`);
      }
    }
    if (Math.abs(oracleScore.p - c.p) > 1e-12) fail(`trial ${trial}: p mismatch`);
    if (oracleScore.recommendedPull !== c.recommendedPull) {
      fail(`trial ${trial}: recommended pull mismatch`);
    }
    if (c.offsets.length === 0) fail(`trial ${trial}: candidate with empty offsets returned`);
    if (c.pulls.some((pull) => pull.offsets.length > 1)) multiSword++;
  }

  // The first candidate must be the FIRST sword-bearing bomb seed: no
  // earlier interval may qualify.
  let s = start;
  for (let i = 0; i < candidates[0].interval; i++) {
    const pb = bombAt(s);
    if (pb !== null) {
      const score = scorePullOptions(scanWindows(pb, CURRENT_PULL_MODEL), CURRENT_PULL_MODEL);
      if (score.p > 0) {
      fail(`trial ${trial}: earlier qualifying candidate at interval ${i}`);
      break;
      }
    }
    s = rngAdv(s);
  }
}

console.log(`findScoredCandidates: ${TRIALS} trials, ` +
  `${(totalCandidates / TRIALS).toFixed(2)} candidates/trial, ` +
  `${multiSword} multi-sword windows`);

/* --- pull probability model ----------------------------------------- */

for (const route of CURRENT_PULL_MODEL.routes) {
  let mass = 0;
  const lo = Math.floor(route.mean - 8 * route.sigma);
  const hi = Math.ceil(route.mean + 8 * route.sigma);
  for (let offset = lo; offset <= hi; offset++) {
    mass += integerNormalProbability(offset, route);
  }
  if (Math.abs(mass - 1) > 1e-5) {
    fail(`${route.id}: integer-bin probabilities sum to ${mass}, expected 1`);
  }
  const center = Math.round(route.mean);
  const centerP = integerNormalProbability(center, route);
  const tailP = integerNormalProbability(center + Math.round(2 * route.sigma), route);
  if (!(centerP > tailP)) fail(`${route.id}: center should score above 2σ tail`);
}

{
  const early = CURRENT_PULL_MODEL.routes.find((route) => route.id === 'early');
  const late = CURRENT_PULL_MODEL.routes.find((route) => route.id === 'late');
  const score = scorePullOptions({
    early: [Math.round(early.mean + 2 * early.sigma)],
    late: [Math.round(late.mean)],
  });
  if (score.recommendedPull !== 'late') fail('model should recommend stronger late pull');
}
console.log('pull probability model: ok');

/* --- manipTimeFrames -------------------------------------------------- */

for (let trial = 0; trial < 100; trial++) {
  const rolls = 41 + Math.floor(Math.random() * 4959);
  const seq = buildActionSequence(rolls, false);
  let sumRolls = 0;
  let sumFrames = 0;
  for (const [action, count] of seq.entries()) {
    sumRolls += action.rolls * count;
    sumFrames += action.frames * count;
  }
  if (sumRolls !== rolls) fail(`manip: action sequence for ${rolls} sums to ${sumRolls}`);
  if (manipTimeFrames(rolls) !== sumFrames) fail(`manip: manipTimeFrames(${rolls}) != manual sum`);
  if (sumFrames <= 0) fail(`manip: nonpositive time for ${rolls}`);
}
// CSS-only path (<= 40 rolls)
if (manipTimeFrames(3) <= 0) fail('manip: CSS-only path returned nonpositive time');
if (manipTimeFrames(0) !== 0) fail('manip: zero rolls should cost zero frames');
console.log('manipTimeFrames: 100 trials ok');

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll scoring tests passed.');
