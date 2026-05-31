// Differential test for charrss.js (CVP reconstruction).
//
//  1. CHAR_RANGES parity: JS interval table == rng.cpp CHAR_RANGES.
//  2. Primary: thousands of random anchors -> 9-char sequence -> assert
//     searchForCharSeed === next^(2N-1)(anchor) and the engine's anchor set == [anchor].
//     (charrss.py's cvp_search reference already proved 5000/5000, zero false
//      positives -- this confirms the JS port reproduces it.)
//  3. Edge cases: char0 = 0 / 24, repeated chars.
//  4. Cross-impl: compare JS anchor sets to charrss.py dump (/tmp/charrss_anchors.json).
//
// Run:  node tools/charrss_difftest.mjs [numRandom]

import { readFileSync } from 'node:fs';
import { rngAdv, rngInt } from '../browser/static/js/util.js';
import { searchForCharSeed, engineFor, next2, getLU } from '../browser/static/js/charrss.js';

const N = 9;                  // first-search length
let failures = 0;
const fail = (msg) => { console.error('  FAIL: ' + msg); failures++; };

// rng.cpp CHAR_RANGES: {start, length}
const CHAR_RANGES = [
  [0,171835392],[171835392,171769856],[343605248,171835392],[515440640,171769856],
  [687210496,171835392],[859045888,171769856],[1030815744,171835392],[1202651136,171769856],
  [1374420992,171769856],[1546190848,171835392],[1718026240,171769856],[1889796096,171835392],
  [2061631488,171769856],[2233401344,171835392],[2405236736,171769856],[2577006592,171835392],
  [2748841984,171769856],[2920611840,171769856],[3092381696,171835392],[3264217088,171769856],
  [3435986944,171835392],[3607822336,171769856],[3779592192,171835392],[3951427584,171769856],
  [4123197440,171769856],
];

function generateChars(u, len) {
  const out = [rngInt(u, 25)];
  let s = u;
  for (let k = 1; k < len; k++) { s = next2(s); out.push(rngInt(s, 25)); }
  return out;
}
function expectedSeed(u, len) {       // next^(2*len-1)(u)
  let s = u;
  for (let i = 0; i < 2 * len - 1; i++) s = rngAdv(s);
  return s;
}
function arrEq(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }

// ---- 1. CHAR_RANGES parity ----
console.log('[1] CHAR_RANGES parity...');
for (let v = 0; v < 25; v++) {
  const [lo, hi] = getLU(v);
  const start = lo, length = hi - lo + 1;
  if (start !== CHAR_RANGES[v][0] || length !== CHAR_RANGES[v][1]) {
    fail(`char ${v}: got [${start}, ${length}] expected ${CHAR_RANGES[v]}`);
  }
}
console.log('    ok');

// ---- 2. Primary random differential ----
const numRandom = parseInt(process.argv[2] || '3000', 10);
console.log(`[2] ${numRandom} random anchors...`);
const eng = engineFor(N);
let seedState = 0x12345678 >>> 0;
function nextRand() {            // simple LCG for test-seed selection (full 32-bit)
  seedState = (Math.imul(seedState, 1103515245) + 12345) >>> 0;
  return seedState;
}
let okCount = 0, falsePos = 0, multi = 0, maxVisited = 0, sumVisited = 0;
for (let t = 0; t < numRandom; t++) {
  const u = nextRand();
  const chars = generateChars(u, N);
  const { anchors, visited } = eng.search(chars);
  sumVisited += visited; if (visited > maxVisited) maxVisited = visited;
  // every returned anchor must regenerate the sequence
  for (const a of anchors) if (!arrEq(generateChars(a, N), chars)) falsePos++;
  if (anchors.length > 1) multi++;
  if (!anchors.includes(u)) { fail(`anchor ${u} not found (got ${anchors})`); continue; }
  const got = searchForCharSeed(chars);
  if (got !== expectedSeed(u, N)) { fail(`seed for anchor ${u}: got ${got} expected ${expectedSeed(u, N)}`); continue; }
  okCount++;
}
console.log(`    ${okCount}/${numRandom} correct, false_pos=${falsePos}, multi_match=${multi}, ` +
            `residual avg=${Math.round(sumVisited / numRandom)} max=${maxVisited}`);
if (okCount !== numRandom || falsePos !== 0) fail('primary differential did not fully pass');

// ---- 3. Edge cases ----
console.log('[3] edge cases...');
const edgeAnchors = [];
for (const v of [0, 24]) edgeAnchors.push(getLU(v)[0] + 1);   // char0 == 0 / 24
edgeAnchors.push(0, 1, 0xFFFFFFFF >>> 0);                      // boundary seeds
for (const u of edgeAnchors) {
  const chars = generateChars(u, N);
  const got = searchForCharSeed(chars);
  if (got !== expectedSeed(u, N)) fail(`edge anchor ${u}: got ${got} expected ${expectedSeed(u, N)}`);
}
console.log('    ok');

// ---- 4. Cross-impl vs charrss.py dump ----
console.log('[4] cross-impl vs charrss.py...');
try {
  const anchorPath = new URL('../temp/charrss_anchors.json', import.meta.url).pathname;
  const rows = JSON.parse(readFileSync(anchorPath, 'utf8'));
  let mism = 0;
  for (const row of rows) {
    const { anchors } = eng.search(row.chars);
    if (!arrEq(anchors, row.anchors)) {
      fail(`anchor-set mismatch for u=${row.u}: js=${anchors} py=${row.anchors}`); mism++;
    }
  }
  console.log(`    compared ${rows.length} sequences, ${mism} mismatches`);
} catch (e) {
  console.log(`    SKIPPED (no temp/charrss_anchors.json: ${e.message})`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
