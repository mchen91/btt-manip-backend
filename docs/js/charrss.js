// charrss.js -- client-side Reverse Seed Search for Melee's random character
// selection. Direct truncated-LCG / Hidden-Number-Problem seed reconstruction via
// a Schnorr-Euchner closest-vector (CVP) enumeration. Runtime port of charrss.py's
// cvp_search; the offline LLL reduction lives in tools/gen_charrss_constants.py and
// is baked into charrss_constants.js.
//
// Reconstructs the seed from 9 characters with no linear-combination budget
// constraint: the HNP lattice has no sum|c|<bound requirement, so 9 chars provides
// sufficient information (validated 5000/5000, no false positives --
// see RSS_IMPLEMENTATION.md).
//
// Implements searchForNewSeed() client-side. Given the first N characters
// (ints 0..24), returns the current RNG seed -- next^(2N-1)(anchor), identical
// to what rng.cpp locateCharSequence_ returned and to the successive-search
// endSeed -- so processSeed() is unchanged.
//
// NUMERICAL STRATEGY: correctness comes from regenerating the character sequence and
// comparing exactly at every enumeration leaf (rngInt semantics via util.js / next2,
// done in Number/Math.imul). The lattice/enumeration math is plain float64 -- it only
// PROPOSES candidate seeds, so double precision is sufficient (matches the Python
// reference exactly). No BigInt is needed.

import { rngAdv, rngInt } from './util.js';
import { CHARRSS_TABLES } from './charrss_constants.js';

// ---- LCG constants -------------------------------------------------------
const A = 214013;
const C = 2531011;
const BOUND = 25;
const HSIZE = 65536;
const MAXINT = 4294967295;       // 2^32 - 1
const SIZE = 4294967296;         // 2^32
// next2 = one character step = two LCG steps.  A*A and A*C+C are < 2^53, exact.
const A2 = (A * A) % SIZE;
const C2 = (A * C + C) % SIZE;

// Radius padding for the enumeration: the true error vector has squared norm <=
// sum of squared interval half-widths; we search a comfortably larger ball so float
// error can never prune the true seed (every leaf is exact-verified regardless).
const RADIUS_PAD = 1.5;

// next2(seed): two LCG steps, exact mod 2^32 via Math.imul.
function next2(seed) {
  return (Math.imul(seed, A2) + C2) >>> 0;
}

// ---- Interval helpers (bound=25) -- mirror charrss.py / rng.cpp CHAR_RANGES
function lowerBound(val) {
  return Math.floor((HSIZE / BOUND) * val + 1) * HSIZE;
}
function getLU(val) {            // [lo, hi] inclusive seed interval for char value
  if (val === 0) return [0, lowerBound(1) - 1];
  if (val === BOUND - 1) return [lowerBound(val), MAXINT];
  return [lowerBound(val), lowerBound(val + 1) - 1];
}

// b_k: affine offset of next2^k -- next2^k(s) = A2^k * s + b_k (mod 2^32).
// b_0 = 0, b_k = (b_{k-1}*A2 + C2) mod 2^32. Exact via Math.imul.
function charOffsets(n) {
  const b = new Array(n);
  b[0] = 0;
  for (let k = 1; k < n; k++) b[k] = (Math.imul(b[k - 1], A2) + C2) >>> 0;
  return b;
}

// regenerate the N characters produced from anchor u (u itself yields char0).
function generateChars(u, n) {
  const out = new Array(n);
  out[0] = rngInt(u, BOUND);
  let s = u;
  for (let k = 1; k < n; k++) { s = next2(s); out[k] = rngInt(s, BOUND); }
  return out;
}
function charsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- Engine: CVP enumeration over a baked lattice for a fixed length ------
class CharRss {
  constructor(table) {
    this.n = table.n;
    this.gsStar = table.gsStar;     // b*_i  (n x n floats)
    this.gsDen = table.gsDen;       // ||b*_i||^2  (n floats)
    this.mu = table.mu;             // mu[j][i] = <R[j],b*_i>/||b*_i||^2
    this.r0 = table.r0;             // column 0 of R (anchor-seed coordinate)
    this.bvec = charOffsets(this.n);
    this.visited = 0;               // leaves verified by regeneration
  }

  // Returns { anchors: Number[] (ascending), visited: Number }.
  search(chars) {
    this.visited = 0;
    const n = this.n;
    if (chars.length !== n) {
      throw new Error(`charrss: expected ${n} characters, got ${chars.length}`);
    }
    const { gsStar, gsDen, mu, r0, bvec } = this;

    // Target (center of each char's seed interval, minus the affine offset) and
    // the squared-radius budget from the interval half-widths.
    const t = new Array(n);
    let halfw2 = 0;
    for (let k = 0; k < n; k++) {
      const [lo, up] = getLU(chars[k]);
      const center = Math.floor((lo + up) / 2);
      let tk = (center - bvec[k]) % SIZE;
      if (tk < 0) tk += SIZE;
      t[k] = tk;
      const hw = (up - lo) / 2;
      halfw2 += hw * hw;
    }
    const r2 = halfw2 * RADIUS_PAD;

    // Target coordinates in the Gram-Schmidt basis.
    const tstar = new Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += t[k] * gsStar[i][k];
      tstar[i] = acc / gsDen[i];
    }

    const x = new Array(n).fill(0);
    const found = new Set();
    const self = this;

    // Schnorr-Euchner enumeration: pick coefficients from the most-significant GS
    // direction down; prune by accumulated squared distance; verify at the leaf.
    function rec(i, dacc) {
      if (i < 0) {
        let u = 0;
        for (let k = 0; k < n; k++) u += x[k] * r0[k];
        u >>>= 0;                                  // mod 2^32
        self.visited++;
        if (charsEqual(generateChars(u, n), chars)) found.add(u);
        return;
      }
      let s = 0;
      for (let j = i + 1; j < n; j++) s += x[j] * mu[j][i];
      const center = tstar[i] - s;
      const rem = r2 - dacc;
      if (rem < 0) return;
      const bound = Math.sqrt(rem / gsDen[i]);
      const loX = Math.floor(center - bound) - 1;
      const hiX = Math.ceil(center + bound) + 1;
      for (let xi = loX; xi <= hiX; xi++) {
        const d = xi - center;
        const dnew = dacc + gsDen[i] * d * d;
        if (dnew <= r2) { x[i] = xi; rec(i - 1, dnew); }
      }
    }
    rec(n - 1, 0);

    const anchors = Array.from(found).sort((a, b) => a - b);
    return { anchors, visited: this.visited };
  }
}

// ---- Public API ----------------------------------------------------------

// Build (and cache) an engine for a given character-sequence length.
const _engines = new Map();
function engineFor(numChars) {
  if (_engines.has(numChars)) return _engines.get(numChars);
  const table = CHARRSS_TABLES[numChars];
  if (!table) {
    throw new Error(`charrss: no baked table for ${numChars} characters ` +
      `(supported: ${Object.keys(CHARRSS_TABLES).join(', ')})`);
  }
  const eng = new CharRss(table);
  _engines.set(numChars, eng);
  return eng;
}

// searchForCharSeed(charSeq): the seed handed to processSeed -- next^(2N-1)(anchor),
// matching rng.cpp locateCharSequence_ and the successive-search endSeed convention.
// Returns -1 if no seed produces the sequence (a safe "not found": the verify step
// means a wrong candidate is never returned). Throws if the length has no baked table.
function searchForCharSeed(charSeq) {
  const N = charSeq.length;
  const eng = engineFor(N);
  const { anchors } = eng.search(charSeq);
  if (anchors.length === 0) return -1;
  if (anchors.length > 1) {
    // 9 chars uniquely pins the seed in practice; this is a safety net mirroring
    // the server (smallest match) + the tool's "enter more characters" model.
    console.warn(`charrss: ${anchors.length} candidate seeds; using smallest. ` +
      `Enter more characters to disambiguate.`);
  }
  let s = anchors[0];                 // anchor u: rngInt(u,25) == charSeq[0]
  const steps = 2 * N - 1;            // advance to the post-sequence seed
  for (let i = 0; i < steps; i++) s = rngAdv(s);
  return s;
}

// Internals exported for differential testing / asserting CHAR_RANGES parity.
export {
  searchForCharSeed,
  CharRss,
  engineFor,
  next2,
  lowerBound,
  getLU,
};
