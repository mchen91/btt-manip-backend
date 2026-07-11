/*
 * m-protocol data collection (passive run-consumption measurement)
 * ------------------------------------------------------------------
 * Connects to a local m-protocol daemon (github.com/gainge/m-protocol)
 * that reads Melee memory from Dolphin and streams it over WebSocket.
 * While connected, this module measures how many RNG rolls each BTT run
 * consumes between the manip'd bomb pull and the sword-slot pull, by
 * reading match.random_seed at the pull frames. Those measurements feed
 * the consumption model (mean/σ) used to score targetprey candidates.
 *
 * RULE BOUNDARY (deliberate, structural): this module is strictly
 * passive. Memory-derived data tunes the model used to plan FUTURE
 * runs; it is never fed into the seed engine, never locates or verifies
 * a seed, and never assists the run in progress. The only cross-module
 * calls are:
 *     window.getLastTargetInfo()        (script.js, read-only)
 *     window.getMeasuredRunModel = ...  (consumed by script.js searches)
 *
 * How a measurement happens:
 *  1. Every daemon delta is sampled into a ring buffer of
 *     { frame, seed, actionState, actionFrame }.
 *  2. A transition into Peach's vegetable-pull action state (id 352,
 *     character-specific) marks a pull. action_frame resets to 1 on
 *     transition, so the exact transition frame is
 *     (sampleFrame - (actionFrame - 1)); the seed at that frame is looked
 *     up in the ring buffer.
 *  3. Pull #1 is anchored against the current manip target: its measured
 *     seed must sit a few rolls after the target's event seed. This both
 *     starts an attempt and confirms the manip landed. Pulls then count
 *     up: #2 = mandatory turnip, #3 = sword slot.
 *  4. Consumption C = roll distance from the target's post-bomb seed to
 *     the seed at pull #3's frame. Attempts are persisted and the
 *     mean/σ over all recorded C values is the measured model.
 *
 * Known measurement caveat: the daemon samples memory mid-frame
 * (~60Hz, not vsync-locked), so each seed reading sits at an arbitrary
 * point within its frame (~10 rolls of in-run consumption). That adds a
 * small constant-ish bias and ~10 rolls of jitter to C — negligible
 * against σ≈36, and consistent across attempts since the model and the
 * measurement share the same convention.
 */

import { rngAdv, rngInt } from './util.js';

// Environment seams so the module also imports cleanly in node for the
// headless test suite (tools/test_datacollect.mjs).
const GLOBAL = typeof window !== 'undefined' ? window : globalThis;
const store = typeof localStorage !== 'undefined'
  ? localStorage
  : { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const STORAGE_KEY_ATTEMPTS = 'manip.rundata.v2';
const STORAGE_KEY_ENABLED = 'manip.dc.enabled.v1';
const STORAGE_KEY_PORT = 'manip.dc.port.v1';

const MAX_ATTEMPTS_STORED = 2000;
const BUFFER_SAMPLES = 1500; // ~25s of per-frame samples

// Peach's vegetable-pull action state (character-specific; measured
// directly on the game rig).
const PULL_ACTION_STATE = 352;

// Pull #1 must measure within this many rolls after the target event seed
// to anchor an attempt (stage load consumes 12, the pull itself 2, plus
// mid-frame sampling slop).
const ANCHOR_MAX_ROLLS = 40;

// Max roll distance scanned when measuring C (post-bomb -> pull #3) and
// when anchoring pull #1. Generous vs mean+4σ.
const DISTANCE_SCAN_MAX = 20000;

// An attempt goes stale if pull #3 hasn't shown up this long after pull #1.
const ATTEMPT_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  client: null,
  enabled: store.getItem(STORAGE_KEY_ENABLED) === '1',
  port: Number(store.getItem(STORAGE_KEY_PORT) || '1'),

  buffer: [], // ring of { frame, seed, actionState, actionFrame }
  lastSampledFrame: -1,
  prevActionState: null,

  // Active attempt (anchored at pull #1)
  attempt: null, // { target, pullCount, startedAt }

  attempts: loadAttempts(),
};

let els = {};

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

function loadAttempts() {
  try {
    const raw = store.getItem(STORAGE_KEY_ATTEMPTS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveAttempts() {
  if (state.attempts.length > MAX_ATTEMPTS_STORED) {
    state.attempts = state.attempts.slice(-MAX_ATTEMPTS_STORED);
  }
  store.setItem(STORAGE_KEY_ATTEMPTS, JSON.stringify(state.attempts));
}

/* ------------------------------------------------------------------ */
/* Model                                                              */
/* ------------------------------------------------------------------ */

function computeModel() {
  const cs = state.attempts.map((a) => a.c).filter((c) => Number.isFinite(c));
  const n = cs.length;
  if (n === 0) return { n: 0, mean: NaN, sigma: NaN };
  const mean = cs.reduce((s, c) => s + c, 0) / n;
  if (n === 1) return { n, mean, sigma: NaN };
  const varSum = cs.reduce((s, c) => s + (c - mean) * (c - mean), 0);
  return { n, mean, sigma: Math.sqrt(varSum / (n - 1)) };
}

// Consumed by script.js's getRunModel() before every targetprey search.
GLOBAL.getMeasuredRunModel = computeModel;

/* ------------------------------------------------------------------ */
/* Seed arithmetic                                                    */
/* ------------------------------------------------------------------ */

// Roll distance from seed a to seed b, scanning forward up to max.
// Returns -1 when b is not within max rolls of a.
function rollDistance(a, b, max) {
  let s = a;
  for (let i = 0; i <= max; i++) {
    if (s === b) return i;
    s = rngAdv(s);
  }
  return -1;
}

// What the game would pull if the decision rolls started from `seed`.
// Estimated: mid-frame sampling means the true decision seed may sit a few
// rolls away. Pull layout mirrors event.js: adv -> rngInt(128) item check,
// then adv -> rngInt(6) item type.
function estimateOutcome(seed) {
  let s = rngAdv(seed);
  if (rngInt(s, 128) !== 0) return 'turnip';
  s = rngAdv(s);
  const t = rngInt(s, 6);
  if (t <= 1) return 'bomb';
  if (t <= 4) return 'saturn';
  return 'sword';
}

/* ------------------------------------------------------------------ */
/* Sampling + pull detection                                          */
/* ------------------------------------------------------------------ */

function pathFor(leaf) {
  return `player.${state.port}.entity.${leaf}`;
}

function subscriptions() {
  return [
    'frame',
    'match.random_seed',
    'menu.major',
    pathFor('action_state'),
    pathFor('action_frame'),
  ];
}

function onDelta() {
  const c = state.client;
  const frame = c.get('frame');
  const seed = c.get('match.random_seed');
  if (typeof frame !== 'number' || typeof seed !== 'number') return;
  if (frame === state.lastSampledFrame) return;
  state.lastSampledFrame = frame;

  const actionState = c.get(pathFor('action_state')); // may be null on CSS
  const actionFrame = c.get(pathFor('action_frame'));

  state.buffer.push({ frame, seed, actionState, actionFrame });
  if (state.buffer.length > BUFFER_SAMPLES) state.buffer.shift();

  // Expire a stale attempt.
  if (state.attempt && Date.now() - state.attempt.startedAt > ATTEMPT_TIMEOUT_MS) {
    state.attempt = null;
    setStatus('attempt timed out — waiting for next manip’d run');
  }

  // Detect a transition into the pull action state.
  const prev = state.prevActionState;
  state.prevActionState = actionState;
  if (typeof actionState !== 'number' || actionState === prev) return;

  if (actionState === PULL_ACTION_STATE) {
    onPullDetected(frame, actionFrame);
  }
}

// Resolve the seed at the pull's transition frame and route it through the
// attempt state machine.
function onPullDetected(sampleFrame, actionFrame) {
  const back = typeof actionFrame === 'number' && actionFrame >= 1
    ? Math.round(actionFrame) - 1
    : 0;
  const targetFrame = sampleFrame - back;

  // Nearest buffered sample at or before the transition frame.
  let best = null;
  for (let i = state.buffer.length - 1; i >= 0; i--) {
    const s = state.buffer[i];
    if (s.frame <= targetFrame) { best = s; break; }
  }
  if (!best) return;
  const frameSlop = targetFrame - best.frame; // >0 when the exact frame was missed

  handlePull(best.seed, frameSlop);
}

function handlePull(seedAtPull, frameSlop) {
  const target = GLOBAL.getLastTargetInfo ? GLOBAL.getLastTargetInfo() : null;

  // Anchor check: is this pull #1 of the current manip target?
  // (Only bomb-first targets are measurable: naive bomb mode + targetprey.)
  if (target && (target.item === 'bomb' || target.item === 'targetprey')) {
    const d = rollDistance(target.eventSeed, seedAtPull, ANCHOR_MAX_ROLLS);
    if (d >= 0) {
      state.attempt = { target, pullCount: 1, startedAt: Date.now() };
      setStatus(`pull 1 anchored (${d} rolls after target) — manip confirmed`);
      return;
    }
  }

  if (!state.attempt) return; // unanchored pull (practice, missed manip, etc.)

  state.attempt.pullCount++;
  if (state.attempt.pullCount === 2) {
    setStatus('pull 2 (turnip) seen');
    return;
  }
  if (state.attempt.pullCount !== 3) return;

  // Pull #3 = the sword slot: measure consumption from the post-bomb seed.
  const t = state.attempt.target;
  state.attempt = null;
  const c = rollDistance(t.postPullSeed, seedAtPull, DISTANCE_SCAN_MAX);
  if (c < 0) {
    setStatus('pull 3 seen but seed off-orbit — measurement discarded');
    return;
  }

  const record = {
    ts: Date.now(),
    c,
    out: estimateOutcome(seedAtPull),
    slop: frameSlop,
    item: t.item,
  };
  state.attempts.push(record);
  saveAttempts();

  let vsOffsets = '';
  if (t.offsets && t.offsets.length) {
    const nearest = t.offsets.reduce(
      (m, o) => (Math.abs(o - c) < Math.abs(m - c) ? o : m), t.offsets[0]);
    vsOffsets = ` (nearest sword offset ${nearest}, Δ${c - nearest})`;
  }
  setStatus(`recorded C=${c}, est. ${record.out}${vsOffsets}`);
  render();
}

/* ------------------------------------------------------------------ */
/* Connection                                                         */
/* ------------------------------------------------------------------ */

function connect() {
  if (state.client || typeof GLOBAL.MProtocol !== 'function') return;
  const client = new GLOBAL.MProtocol({ subscribe: subscriptions() });
  state.client = client;

  client.on('welcome', () => setConn('connected (waiting for Dolphin)'));
  client.on('attach', (m) => setConn(`attached to ${m.process || 'Dolphin'}`));
  client.on('detach', () => {
    resetStream();
    setConn('daemon up, Dolphin detached');
  });
  client.on('snapshot', () => resetStream());
  client.on('delta', onDelta);
  client.on('connecting', () => setConn('connecting…'));
  client.on('reconnect', (r) => setConn(`daemon unreachable — retrying (attempt ${r.attempt})`));

  client.connect();
}

function disconnect() {
  if (!state.client) return;
  state.client.close();
  state.client = null;
  resetStream();
  setConn('off');
}

function resetStream() {
  state.buffer = [];
  state.lastSampledFrame = -1;
  state.prevActionState = null;
  state.attempt = null;
}

/* ------------------------------------------------------------------ */
/* UI                                                                 */
/* ------------------------------------------------------------------ */

function setConn(msg) {
  if (els.conn) els.conn.textContent = `daemon: ${msg}`;
}

function setStatus(msg) {
  if (els.status) els.status.textContent = msg;
}

function drawHistogram() {
  const canvas = els.hist;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cs = state.attempts.map((a) => a.c).filter((c) => Number.isFinite(c));
  if (cs.length < 2) return;

  const lo = Math.min(...cs);
  const hi = Math.max(...cs);
  const span = Math.max(1, hi - lo);
  const nBins = Math.min(24, Math.max(6, Math.floor(cs.length / 3)));
  const bins = new Array(nBins).fill(0);
  for (const c of cs) {
    const b = Math.min(nBins - 1, Math.floor(((c - lo) / span) * nBins));
    bins[b]++;
  }
  const maxBin = Math.max(...bins);
  const w = canvas.width / nBins;
  ctx.fillStyle = '#7aa2f7';
  bins.forEach((count, i) => {
    const h = (count / maxBin) * (canvas.height - 2);
    ctx.fillRect(i * w + 1, canvas.height - h, w - 2, h);
  });
}

function render() {
  const m = computeModel();
  if (els.stats) {
    els.stats.textContent = m.n === 0
      ? 'no measurements yet'
      : `n=${m.n} · mean ${m.mean.toFixed(1)} · σ ${Number.isFinite(m.sigma) ? m.sigma.toFixed(1) : '—'}`
        + (m.n < 20 ? ' (model activates at n=20)' : ' (model ACTIVE for targetprey)');
  }
  drawHistogram();
}

function exportJson() {
  const blob = new Blob(
    [JSON.stringify({ exportedAt: new Date().toISOString(), attempts: state.attempts }, null, 2)],
    { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `run-data-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onEnableToggle() {
  state.enabled = els.enable.checked;
  store.setItem(STORAGE_KEY_ENABLED, state.enabled ? '1' : '0');
  if (state.enabled) connect();
  else disconnect();
}

function onPortChange() {
  state.port = Number(els.port.value);
  store.setItem(STORAGE_KEY_PORT, String(state.port));
  if (state.client) state.client.updateSubscribe(subscriptions());
  resetStream();
}

function init() {
  if (typeof document === 'undefined') return; // headless (node test) import
  els = {
    panel: document.getElementById('dc-panel'),
    toggle: document.getElementById('dc-toggle'),
    body: document.getElementById('dc-body'),
    enable: document.getElementById('dc-enable'),
    port: document.getElementById('dc-port'),
    conn: document.getElementById('dc-conn'),
    stats: document.getElementById('dc-stats'),
    hist: document.getElementById('dc-hist'),
    status: document.getElementById('dc-status'),
    exportBtn: document.getElementById('dc-export'),
    clearBtn: document.getElementById('dc-clear'),
  };
  if (!els.panel) return;

  els.toggle.addEventListener('click', () => els.body.classList.toggle('none'));
  els.enable.checked = state.enabled;
  els.enable.addEventListener('change', onEnableToggle);
  els.port.value = String(state.port);
  els.port.addEventListener('change', onPortChange);
  els.exportBtn.addEventListener('click', exportJson);
  els.clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all recorded run measurements?')) return;
    state.attempts = [];
    saveAttempts();
    render();
    setStatus('measurements cleared');
  });

  setConn('off');
  render();
  if (state.enabled) connect();
}

init();

// Test seam (tools/test_datacollect.mjs). Not used by the page.
export { rollDistance, estimateOutcome, computeModel };
export const __testHooks = { state, handlePull, onPullDetected, onDelta, resetStream };
