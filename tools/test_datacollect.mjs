#!/usr/bin/env node
// Verification for the m-protocol data collector (docs/js/datacollect.js):
// drives the module's real delta pipeline with a synthetic daemon feed whose
// seeds follow the actual LCG, and checks that pull anchoring, action_frame
// back-correction, consumption measurement, and outcome estimation all land
// on constructed ground truth.
//
// Usage: node tools/test_datacollect.mjs

import { rngAdv, rngInt } from '../docs/js/util.js';

const dc = await import('../docs/js/datacollect.js');
const { rollDistance, estimateOutcome, computeModel } = dc;
const { state, handlePull, onDelta, resetStream } = dc.__testHooks;

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error('FAIL: ' + msg);
  }
}

function advance(seed, n) {
  for (let i = 0; i < n; i++) seed = rngAdv(seed);
  return seed;
}

// Find an offset near `around` (searching outward) where the next pull from
// advance(base, offset) yields the wanted item type.
function findPullOffset(base, around, want) {
  const outcomeAt = (off) => estimateOutcome(advance(base, off));
  for (let d = 0; d < 5000; d++) {
    for (const off of d === 0 ? [around] : [around - d, around + d]) {
      if (off >= 0 && outcomeAt(off) === want) return off;
    }
  }
  throw new Error(`no ${want} offset near ${around}`);
}

/* --- primitives ------------------------------------------------------- */

const E = 0x12345678 >>> 0; // manip target event seed
check(rollDistance(E, advance(E, 137), 500) === 137, 'rollDistance forward');
check(rollDistance(E, 0xdeadbeef, 100) === -1, 'rollDistance miss returns -1');
check(rollDistance(E, E, 10) === 0, 'rollDistance identity');

// estimateOutcome agrees with a direct read of the two decision rolls.
{
  let s = rngAdv(E);
  const isItem = rngInt(s, 128) === 0;
  const out = estimateOutcome(E);
  if (!isItem) check(out === 'turnip', 'estimateOutcome turnip');
  else check(['bomb', 'saturn', 'sword'].includes(out), 'estimateOutcome item class');
}

/* --- handlePull state machine ------------------------------------------ */

const PB = advance(E, 14); // post-bomb seed (stage load 12 + 2 pull rolls)
const SWORD_C = findPullOffset(PB, 1899, 'sword');
const target = {
  item: 'targetprey',
  eventSeed: E,
  postPullSeed: PB,
  interval: 1234,
  offsets: [SWORD_C],
  ts: Date.now(),
};
globalThis.getLastTargetInfo = () => target;

state.attempts.length = 0;
resetStream();

// Unanchored pull before any attempt: ignored.
handlePull(0x0badf00d >>> 0, 0);
check(state.attempt === null && state.attempts.length === 0, 'unanchored pull ignored');

// Pull 1 anchors (13 rolls after the event seed: stage load + first decision roll).
handlePull(advance(E, 13), 0);
check(state.attempt !== null && state.attempt.pullCount === 1, 'pull 1 anchors attempt');

// Pull 2 (turnip) advances the count without recording.
handlePull(advance(PB, 950), 0);
check(state.attempt.pullCount === 2 && state.attempts.length === 0, 'pull 2 counted, not recorded');

// Pull 3 records consumption C exactly.
handlePull(advance(PB, SWORD_C), 0);
check(state.attempt === null, 'attempt closed after pull 3');
check(state.attempts.length === 1, 'pull 3 recorded');
check(state.attempts[0].c === SWORD_C, `C measured exactly (${state.attempts[0].c} vs ${SWORD_C})`);
check(state.attempts[0].out === 'sword', 'outcome estimated as sword');

// Re-anchor mid-attempt (user reset and re-ran the same manip).
handlePull(advance(E, 13), 0);
handlePull(advance(E, 12), 0); // reset, ran again: pull 1 again
check(state.attempt !== null && state.attempt.pullCount === 1, 're-anchor restarts attempt');
const TURNIP_C = findPullOffset(PB, 1899, 'turnip');
handlePull(advance(PB, 900), 0);
handlePull(advance(PB, TURNIP_C), 0);
check(state.attempts.length === 2 && state.attempts[1].out === 'turnip',
  'second attempt recorded with turnip outcome');

const m = computeModel();
check(m.n === 2, 'model n=2');
check(Math.abs(m.mean - (SWORD_C + TURNIP_C) / 2) < 1e-9, 'model mean');
console.log(`handlePull: ok (C values ${SWORD_C}, ${TURNIP_C})`);

/* --- full onDelta pipeline (synthetic daemon feed) ---------------------- */

state.attempts.length = 0;
resetStream();
state.port = 1;

const IDLE = 14; // "Wait" general action state
const PEACH_PULL = 352; // Peach's vegetable-pull action state (hardcoded in datacollect.js)

// Synthetic run: seed timeline keyed by frame. In-run consumption ~10
// rolls/frame after the bomb; pulls at known frames with known seeds.
const PULL1_FRAME = 20;
const PULL2_FRAME = 100;
const PULL3_FRAME = 190;
const C3 = findPullOffset(PB, 1880, 'sword');

const seedByFrame = (f) => {
  if (f < PULL1_FRAME) return advance(E, 12);              // stage loaded, pre-pull
  if (f < PULL2_FRAME) {
    // interpolate consumption from pull1 (E+13) toward pull2
    const t = advance(E, 13);
    return advance(t, Math.min(950, (f - PULL1_FRAME) * 12));
  }
  if (f < PULL3_FRAME) return advance(PB, 950 + Math.min(C3 - 950, (f - PULL2_FRAME) * 11));
  return advance(PB, C3);
};
const stateByFrame = (f) => {
  if (f >= PULL1_FRAME && f < PULL1_FRAME + 8) return PEACH_PULL;
  if (f >= PULL2_FRAME && f < PULL2_FRAME + 8) return PEACH_PULL;
  if (f >= PULL3_FRAME && f < PULL3_FRAME + 8) return PEACH_PULL;
  return IDLE;
};

let values = {};
state.client = { get: (p) => values[p] };

for (let f = 0; f <= PULL3_FRAME + 20; f++) {
  // Simulate the daemon occasionally reporting the pull one poll late, with
  // action_frame telling us how deep into the state we are: skip the frame
  // of PULL2 so its transition is only observed at PULL2_FRAME+1 with
  // action_frame 2 (exercises the back-correction path).
  if (f === PULL2_FRAME) continue;
  const st = stateByFrame(f);
  const stAge = st === PEACH_PULL
    ? f - [PULL1_FRAME, PULL2_FRAME, PULL3_FRAME].filter((p) => p <= f).pop() + 1
    : 1;
  values = {
    'frame': f,
    'match.random_seed': seedByFrame(f),
    'menu.major': 0x0f,
    'player.1.entity.action_state': st,
    'player.1.entity.action_frame': stAge,
  };
  onDelta();
}

check(state.attempts.length === 1, `onDelta pipeline recorded 1 attempt (got ${state.attempts.length})`);
if (state.attempts.length === 1) {
  check(state.attempts[0].c === C3, `onDelta measured C=${state.attempts[0].c}, expected ${C3}`);
  check(state.attempts[0].out === 'sword', 'onDelta outcome sword');
  // PULL2 transition observed one frame late with action_frame=2: the
  // back-correction lands on frame PULL2_FRAME, whose sample is missing
  // (we skipped it), so the nearest earlier sample is used -> slop bookkeeping
  // only; the pull-2 step records nothing so C is unaffected.
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('onDelta pipeline: ok');
console.log('\nAll datacollect tests passed.');
