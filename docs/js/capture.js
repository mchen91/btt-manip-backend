/*
 * Live Capture (webcam -> character sequence)
 * ------------------------------------------------------------------
 * Watches a video feed of the Melee character-select screen and helps
 * turn each random-character roll into an entry in the seed-search
 * sequence, so you don't have to take a hand off the controller to
 * click icons.
 *
 * This file is deliberately decoupled from all seed/RNG logic. It only
 * ever calls two things that script.js exposes on `window`:
 *     window.addCharToSeq(index)   -- same as clicking a CSS icon
 *     window.searchForSeed()       -- same as pressing "Search"
 *
 * SCOPE OF THIS STEP (foundation): camera selection, 4-corner
 * calibration, homography rectification of the character card, a live
 * head-on preview, and a feed-stability meter. Classification is
 * scaffolded (template capture + nearest-match readout) but wired to a
 * MANUAL "add detected" button only. Automatic per-roll entry and
 * auto-Search are the next step (see AUTO-ENTRY seam near the bottom).
 */

// Character index order MUST match addCharToSeq()'s indexing in script.js
// (CSS grid, row-major, skipping the two hidden "random" slots).
const CHARACTER_NAMES = [
  "Dr. Mario", "Mario", "Luigi", "Bowser", "Peach", "Yoshi", "DK",
  "Captain Falcon", "Ganondorf",
  "Falco", "Fox", "Ness", "Ice Climbers", "Kirby", "Samus", "Zelda",
  "Link", "Young Link",
  "Pichu", "Pikachu", "Jigglypuff", "Mewtwo", "Mr. G&W",
  "Marth", "Roy",
];

// Special template class for the deselected / empty card. It's taught and
// matched exactly like a character, but it never gets added to the sequence;
// instead it acts as the delimiter between rolls (see the auto-entry gate).
const EMPTY_KEY = "empty";
const EMPTY_LABEL = "— deselected —";
function labelForKey(key) {
  return key === EMPTY_KEY ? EMPTY_LABEL : CHARACTER_NAMES[Number(key)];
}

// Rectified card dimensions (the head-on image we classify against).
// The character card is portrait-ish; tune later against real footage.
const RECT_W = 150;
const RECT_H = 200;

// Classification feature: a moderate-resolution COLOR thumbnail of the
// rectified card. Downscaling is for noise/alignment robustness, not
// speed (compare is trivially cheap); we keep it big enough and in color
// to separate 25 characters. Bump these to trade robustness for detail.
const THUMB_W = 48;
const THUMB_H = 64;
const FEATURE_LEN = THUMB_W * THUMB_H * 3; // RGB

// Multi-sample: Capture Template averages this many frames (~1s @ ~15fps)
// so the reference isn't a single noisy webcam frame.
const SAMPLES_PER_TEMPLATE = 20;

// --- Auto-entry event detection (all tunable against real footage) ---
// A "roll" is one motion burst in the card ROI followed by a settle. We
// gate on that cycle (not on the character changing) so rolling the same
// character twice in a row still registers as two rolls.
//
// Thresholds are RELATIVE to an adaptive baseline of the feed's own noise
// floor, so this works regardless of how noisy a given webcam is (absolute
// thresholds get stuck "moving" forever when resting noise is high).
const MOTION_DELTA = 8;      // diff must exceed baseline by this = roll started
const SETTLE_MARGIN = 3;     // diff within baseline+this = settled
const SETTLE_FRAMES = 3;     // consecutive settled frames before we read it
const MOVING_TIMEOUT_MS = 1400; // stuck "moving" this long -> classify anyway
// A roll only counts if it was a STRONG motion (peak this far above
// baseline = a real portrait swap) OR it landed on a different character.
// This rejects idle-animation jitter re-adding the character already shown,
// while still catching a deliberate re-roll onto the same character (which
// swaps the whole portrait and so clears STRONG_PEAK).
const STRONG_PEAK = 20;
const CONF_MIN = 0.72;       // min cosine similarity for the empty-card delimiter
// Auto-add gate. Rather than an absolute similarity floor (which drifts below
// itself as room lighting changes over the day), we require the best match to
// stand out from the runner-up by a RELATIVE margin: (best - second) / best.
// A global dimming compresses every similarity together, so the ratio is stable
// even when the absolute best falls from ~0.92 (calibration) to ~0.72 (night).
// AUTOADD_FLOOR stays only as a garbage guard: it rejects frames where nothing
// matches well (e.g. the stage mid-run), where a large relative margin could
// otherwise appear by chance between two equally-bad candidates.
const AUTOADD_FLOOR = 0.55;  // below this the best match is treated as garbage
const AUTOADD_MARGIN = 0.15; // best must beat 2nd-best by this fraction of best
const ADD_COOLDOWN_MS = 450; // ignore a second "roll" fired this fast
const BASELINE_ALPHA = 0.05; // EMA rate for the noise-floor baseline

// Recording mode / run detection. While "executing" (after a successful
// search), we ignore the card entirely until we detect a run has happened:
// during a run the ROI shows the stage, matching no CSS state, so the best
// similarity drops. Sustained low similarity = a run; similarity returning =
// back on the character-select screen -> resume "locating".
const OFFCSS_CONF = 0.50;  // best similarity below this = not a CSS state
const ONCSS_CONF = 0.62;   // best similarity at/above this = a CSS state again
const OFFCSS_MS = 900;     // sustained off-CSS this long = a run occurred

const STORAGE_KEY_CORNERS = "capture.corners.v1";
const STORAGE_KEY_TEMPLATES = "capture.templates.v2"; // v2: color thumbnails

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  stream: null,
  video: null,
  running: false,
  rafId: null,

  // Calibration: 4 corners of the character card in rawCanvas pixels,
  // ordered top-left, top-right, bottom-right, bottom-left.
  corners: loadCorners(),
  calibrating: false,
  homography: null, // dest(rect) -> src(raw)

  // Classification templates: { [charIndex]: Uint8ClampedArray(FEATURE_LEN) }
  // = the averaged raw RGB thumbnail. templateFeatures caches the
  // normalized (zero-mean, unit-norm) version used for cosine matching.
  templates: loadTemplates(),
  templateFeatures: {},
  collecting: null, // { idx, remaining, total, sum:Float32Array }
  lastRectImageData: null,
  prevLuma: null,
  lastDiff: 0, // most recent inter-frame diff (drives event detection)
  lastMatch: null, // { index, similarity }

  // Auto-entry
  autoEntry: false,
  autoSearch: false,
  eventPhase: "stable", // "stable" | "moving"
  settleFrames: 0,
  movingStart: 0,
  rollPeak: 0, // max (diff - baseline) seen during the current motion burst
  baseline: null, // adaptive noise floor of lastDiff (EMA, updated when stable)
  lastAddTime: 0,
  lastAddedIndex: -1, // last character auto-added (for the identity gate)
  sawEmptySinceAdd: false, // has the card been deselected since the last add?

  // Recording mode
  recordingMode: "locating", // "locating" (record rolls) | "executing" (ignore)
  runSeen: false, // has an off-CSS (in-run) period occurred since executing began?
  offCssSince: 0, // timestamp the ROI first went off-CSS (0 = on-CSS)
  searchPending: false, // a search was fired; ignore input until it resolves
};

/* ------------------------------------------------------------------ */
/* DOM refs (populated in init)                                       */
/* ------------------------------------------------------------------ */

let els = {};

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

function loadCorners() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_CORNERS);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.length === 4 ? parsed : null;
  } catch { return null; }
}

function saveCorners() {
  localStorage.setItem(STORAGE_KEY_CORNERS, JSON.stringify(state.corners));
}

function loadTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TEMPLATES);
    const obj = raw ? JSON.parse(raw) : {};
    const out = {};
    for (const k of Object.keys(obj)) {
      const arr = obj[k];
      if (Array.isArray(arr) && arr.length === FEATURE_LEN) {
        out[k] = Uint8ClampedArray.from(arr);
      }
    }
    return out;
  } catch { return {}; }
}

function saveTemplates() {
  const obj = {};
  for (const k of Object.keys(state.templates)) obj[k] = Array.from(state.templates[k]);
  localStorage.setItem(STORAGE_KEY_TEMPLATES, JSON.stringify(obj));
}

/* ------------------------------------------------------------------ */
/* Homography (4-point projective transform)                          */
/* ------------------------------------------------------------------ */

// Solve H (3x3, h8 = 1) mapping `from[i]` -> `to[i]` for 4 point pairs,
// via Gaussian elimination on the 8x8 DLT system.
function computeHomography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solveLinear(A, b); // length 8
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Gaussian elimination with partial pivoting; solves A x = b (n x n).
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  // Full (Gauss-Jordan) elimination leaves M[i][i] as the only nonzero
  // coefficient in row i, so x_i = rhs_i / M[i][i].
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / (M[i][i] || 1e-12);
  return x;
}

function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [
    (h[0] * x + h[1] * y + h[2]) / w,
    (h[3] * x + h[4] * y + h[5]) / w,
  ];
}

function rebuildHomography() {
  if (!state.corners) { state.homography = null; return; }
  const dst = [[0, 0], [RECT_W, 0], [RECT_W, RECT_H], [0, RECT_H]];
  // dest(rectified) -> src(raw) so we can inverse-sample the output.
  state.homography = computeHomography(dst, state.corners);
}

/* ------------------------------------------------------------------ */
/* Camera                                                             */
/* ------------------------------------------------------------------ */

async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    els.deviceSelect.innerHTML = "";
    cams.forEach((cam, i) => {
      const opt = document.createElement("option");
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      els.deviceSelect.appendChild(opt);
    });
  } catch (e) {
    setStatus(`Could not list cameras: ${e.message}`);
  }
}

async function startCamera() {
  try {
    const deviceId = els.deviceSelect.value || undefined;
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.video = document.createElement("video");
    state.video.srcObject = state.stream;
    state.video.muted = true;
    state.video.playsInline = true;
    await state.video.play();

    // Labels are only populated after permission is granted.
    await listDevices();

    state.running = true;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.calibrateBtn.disabled = false;
    setStatus("Camera running.");
    loop();
  } catch (e) {
    setStatus(`Camera error: ${e.message}`);
  }
}

function stopCamera() {
  state.running = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.video = null;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.calibrateBtn.disabled = true;
  setStatus("Camera stopped.");
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                         */
/* ------------------------------------------------------------------ */

function loop() {
  if (!state.running) return;
  drawRawFrame();
  if (state.homography) {
    rectifyCard();
    if (state.collecting) {
      collectSample();
    } else {
      classifyCurrent();
      updateAutoEntry();
    }
  }
  state.rafId = requestAnimationFrame(loop);
}

function drawRawFrame() {
  const v = state.video;
  if (!v || !v.videoWidth) return;
  const canvas = els.rawCanvas;
  // Size the raw canvas once, capped at 480 wide, preserving aspect.
  if (canvas.width === 0 || canvas.dataset.sized !== "1") {
    const w = Math.min(480, v.videoWidth);
    canvas.width = w;
    canvas.height = Math.round((w * v.videoHeight) / v.videoWidth);
    canvas.dataset.sized = "1";
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  if (state.calibrating || state.corners) drawCornerOverlay(ctx);
}

function drawCornerOverlay(ctx) {
  const pts = state.corners || [];
  if (pts.length) {
    ctx.strokeStyle = "#2bd66b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (pts.length === 4) ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = "#2bd66b";
    pts.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); });
  }
}

// Inverse-warp the raw frame's card quad into a head-on RECT_W x RECT_H image.
function rectifyCard() {
  const rawCtx = els.rawCanvas.getContext("2d", { willReadFrequently: true });
  const src = rawCtx.getImageData(0, 0, els.rawCanvas.width, els.rawCanvas.height);
  const sw = src.width, sh = src.height, sd = src.data;

  const out = new ImageData(RECT_W, RECT_H);
  const od = out.data;
  const h = state.homography;

  for (let y = 0; y < RECT_H; y++) {
    for (let x = 0; x < RECT_W; x++) {
      const [ux, uy] = applyH(h, x, y);
      const sx = ux | 0, sy = uy | 0;
      const di = (y * RECT_W + x) * 4;
      if (sx >= 0 && sx < sw && sy >= 0 && sy < sh) {
        const si = (sy * sw + sx) * 4;
        od[di] = sd[si]; od[di + 1] = sd[si + 1];
        od[di + 2] = sd[si + 2]; od[di + 3] = 255;
      } else {
        od[di + 3] = 255;
      }
    }
  }

  els.rectCanvas.getContext("2d").putImageData(out, 0, 0);
  updateStability(out);
  state.lastRectImageData = out;
}

// Mean absolute luma difference between consecutive rectified frames.
// Low = stable (safe to read); a spike = a roll animation is happening.
function updateStability(img) {
  const d = img.data;
  const luma = new Float32Array(RECT_W * RECT_H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    luma[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }
  let diff = 0;
  if (state.prevLuma) {
    for (let j = 0; j < luma.length; j++) diff += Math.abs(luma[j] - state.prevLuma[j]);
    diff /= luma.length;
  }
  state.prevLuma = luma;
  state.lastDiff = diff;

  // Track the feed's noise floor, but only while not mid-roll, so a roll
  // animation can't inflate the baseline it's measured against.
  if (state.baseline === null) state.baseline = diff;
  else if (state.eventPhase === "stable") {
    state.baseline = state.baseline * (1 - BASELINE_ALPHA) + diff * BASELINE_ALPHA;
  }

  const pct = Math.min(100, diff * 2); // rough scaling for the meter
  els.stabilityBar.style.width = `${pct}%`;
  els.stabilityBar.style.background = diff < 3 ? "#2bd66b" : diff < 12 ? "#f0ad4e" : "#fa6c6c";
  els.stabilityLabel.textContent =
    `${state.eventPhase === "moving" ? "moving" : "stable"} (d ${diff.toFixed(1)} / base ${(state.baseline ?? 0).toFixed(1)})`;
}

/* ------------------------------------------------------------------ */
/* Classification (color thumbnail + zero-mean unit-norm cosine)      */
/* ------------------------------------------------------------------ */

// Area-averaged downscale of the rectified card to a THUMB_W x THUMB_H
// RGB thumbnail (Uint8ClampedArray, length FEATURE_LEN). Averaging (not
// nearest) is what suppresses webcam noise and sub-pixel jitter.
function makeThumbnail(img) {
  const sw = img.width, sh = img.height, sd = img.data;
  const out = new Uint8ClampedArray(FEATURE_LEN);
  for (let ty = 0; ty < THUMB_H; ty++) {
    const y0 = Math.floor((ty * sh) / THUMB_H);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / THUMB_H));
    for (let tx = 0; tx < THUMB_W; tx++) {
      const x0 = Math.floor((tx * sw) / THUMB_W);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sw) / THUMB_W));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const si = (y * sw + x) * 4;
          r += sd[si]; g += sd[si + 1]; b += sd[si + 2]; n++;
        }
      }
      const di = (ty * THUMB_W + tx) * 3;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n;
    }
  }
  return out;
}

// Zero-mean, unit-norm feature vector. Subtracting the mean removes
// overall brightness; unit-norm removes contrast/exposure. Cosine
// similarity of two of these is then robust to lighting while keeping
// color and spatial structure.
function normalizeFeature(px) {
  const f = new Float32Array(px.length);
  let mean = 0;
  for (let i = 0; i < px.length; i++) mean += px[i];
  mean /= px.length;
  let norm = 0;
  for (let i = 0; i < px.length; i++) { const v = px[i] - mean; f[i] = v; norm += v * v; }
  norm = Math.sqrt(norm) || 1e-6;
  for (let i = 0; i < f.length; i++) f[i] /= norm;
  return f;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Rebuild the normalized-feature cache from the stored raw thumbnails.
function rebuildTemplateFeatures() {
  state.templateFeatures = {};
  for (const k of Object.keys(state.templates)) {
    state.templateFeatures[k] = normalizeFeature(state.templates[k]);
  }
}

function classifyCurrent() {
  if (!state.lastRectImageData) return;
  const keys = Object.keys(state.templateFeatures);
  if (keys.length === 0) {
    els.matchLabel.textContent = "No templates captured yet";
    state.lastMatch = null;
    return;
  }
  const live = normalizeFeature(makeThumbnail(state.lastRectImageData));
  let best = null, secondSim = -Infinity;
  for (const k of keys) {
    const sim = dot(live, state.templateFeatures[k]);
    if (!best || sim > best.similarity) {
      secondSim = best ? best.similarity : secondSim;
      best = { key: k, similarity: sim };
    } else if (sim > secondSim) {
      secondSim = sim;
    }
  }
  const isEmpty = best.key === EMPTY_KEY;
  state.lastMatch = {
    key: best.key,
    index: isEmpty ? -1 : Number(best.key),
    isEmpty,
    similarity: best.similarity,
    secondSim: Number.isFinite(secondSim) ? secondSim : 0,
  };
  const conf = Math.max(0, Math.round(best.similarity * 100));
  const margin = Math.round((best.similarity - secondSim) * 100);
  els.matchLabel.textContent =
    `${labelForKey(best.key)}  (${conf}%${Number.isFinite(margin) ? `, +${margin} vs next` : ""})`;
}

/* ------------------------------------------------------------------ */
/* Auto-entry: roll event detection -> addCharToSeq -> auto-Search     */
/* ------------------------------------------------------------------ */

function setAutoStatus(msg) {
  if (els.autoStatus) els.autoStatus.textContent = msg;
}

function onAutoEntryToggle() {
  state.autoEntry = els.autoEntryCheckbox.checked;
  if (state.autoEntry) enterLocating("on — roll a character…");
  else { updateModeBadge(); setAutoStatus("off"); }
}

function onAutoSearchToggle() {
  state.autoSearch = els.autoSearchCheckbox.checked;
}

// --- Recording-mode transitions ------------------------------------------

function enterExecuting(msg) {
  state.recordingMode = "executing";
  state.runSeen = false;
  state.offCssSince = 0;
  state.eventPhase = "stable";
  state.settleFrames = 0;
  updateModeBadge();
  setAutoStatus(msg || "seed found — recording paused (performing run)");
}

function enterLocating(msg) {
  state.recordingMode = "locating";
  state.runSeen = false;
  state.offCssSince = 0;
  state.searchPending = false;
  state.eventPhase = "stable";
  state.settleFrames = 0;
  state.rollPeak = 0;
  // Require a fresh deselect before the first record, so a character already
  // on the card (e.g. Peach after a run) is never recorded.
  state.lastAddedIndex = -1;
  state.sawEmptySinceAdd = false;
  // Do NOT re-arm the add cooldown here: it only exists to debounce double-fires
  // of a single roll, and there is no prior add to debounce against right after a
  // run. Re-stamping it silently swallowed the first roll back on the CSS.
  state.lastAddTime = 0;
  updateModeBadge();
  if (msg) setAutoStatus(msg);
}

function updateModeBadge() {
  if (!els.modeBadge) return;
  if (!state.autoEntry) {
    els.modeBadge.textContent = "—";
    els.modeBadge.className = "capture-mode";
    return;
  }
  const exec = state.recordingMode === "executing";
  els.modeBadge.textContent = exec ? "❚❚ run (not recording)" : "● recording";
  els.modeBadge.className = "capture-mode " + (exec ? "mode-exec" : "mode-rec");
}

// While executing: detect the run (ROI goes off-CSS) and the return to the
// character-select screen, at which point we resume recording.
function updateRunTransition(now) {
  const sim = state.lastMatch ? state.lastMatch.similarity : 0;
  if (sim < OFFCSS_CONF) {
    if (state.offCssSince === 0) state.offCssSince = now;
    else if (!state.runSeen && now - state.offCssSince > OFFCSS_MS) {
      state.runSeen = true;
      setAutoStatus("run in progress…");
    }
  } else if (sim >= ONCSS_CONF) {
    state.offCssSince = 0;
    if (state.runSeen) enterLocating("run finished — recording resumed");
  }
}

// Per-frame state machine.
function updateAutoEntry() {
  if (!state.autoEntry) return;
  const now = performance.now();

  if (state.recordingMode === "executing") {
    updateRunTransition(now);
    return;
  }

  // --- locating: detect one roll = motion burst that settles, then add ---
  const diff = state.lastDiff;
  const base = state.baseline ?? 0;

  // Card deselected (empty) at any point = the delimiter between rolls.
  if (state.lastMatch && state.lastMatch.isEmpty && state.lastMatch.similarity >= CONF_MIN) {
    state.sawEmptySinceAdd = true;
  }

  if (state.eventPhase === "stable") {
    if (diff > base + MOTION_DELTA) {
      state.eventPhase = "moving";
      state.settleFrames = 0;
      state.movingStart = now;
      state.rollPeak = diff - base;
      setAutoStatus("roll detected…");
    }
  } else {
    state.rollPeak = Math.max(state.rollPeak, diff - base);
    if (diff < base + SETTLE_MARGIN) state.settleFrames++;
    else state.settleFrames = 0;

    const timedOut = now - state.movingStart > MOVING_TIMEOUT_MS;
    if (state.settleFrames >= SETTLE_FRAMES || timedOut) {
      state.eventPhase = "stable";
      state.settleFrames = 0;
      onRollSettled(now, state.rollPeak);
    }
  }
}

function onRollSettled(now, peak) {
  if (state.searchPending) return; // a search is resolving; ignore input
  const m = state.lastMatch;
  if (!m) {
    setAutoStatus("roll ended — no classification (templates loaded?)");
    return;
  }
  const pct = Math.round(m.similarity * 100);
  const pk = Math.round(peak);

  // Settling on the empty card = the delimiter, not a roll.
  if (m.isEmpty) {
    state.sawEmptySinceAdd = true;
    setAutoStatus(`deselected — ready for next roll`);
    return;
  }

  if (now - state.lastAddTime < ADD_COOLDOWN_MS) return;

  // New-roll gate: when an empty template is taught, the deselect delimiter is
  // authoritative (this also stops a pre-selected character being recorded).
  // Otherwise fall back to strong-peak / identity-change heuristics.
  const emptyTaught = EMPTY_KEY in state.templates;
  const isNewRoll = emptyTaught
    ? state.sawEmptySinceAdd
    : peak >= STRONG_PEAK || m.index !== state.lastAddedIndex;
  if (!isNewRoll) {
    setAutoStatus(`ignored repeat: ${labelForKey(m.key)} (peak ${pk})`);
    return;
  }

  // Garbage guard: nothing on screen matches a taught template well enough.
  if (m.similarity < AUTOADD_FLOOR) {
    setAutoStatus(`skipped: low confidence (${pct}%, peak ${pk})`);
    return;
  }
  // Differentiation gate: the best match must stand clearly apart from the
  // runner-up. Relative to `best` so it survives global lighting drift.
  const relMargin = (m.similarity - m.secondSim) / m.similarity;
  if (relMargin < AUTOADD_MARGIN) {
    const mp = Math.round(relMargin * 100);
    setAutoStatus(`skipped: ambiguous (${pct}%, +${mp}% vs next, peak ${pk})`);
    return;
  }

  window.addCharToSeq(m.index);
  state.lastAddTime = now;
  state.lastAddedIndex = m.index;
  state.sawEmptySinceAdd = false;
  setAutoStatus(`added ${labelForKey(m.key)} (${pct}%, peak ${pk})`);
  maybeAutoSearchAtQuota();
}

// Fires Search the moment the sequence reaches the required count (9 for the
// first search, 4 for successive ones). The app already encodes that quota in
// the Search button's disabled state, so we reuse it rather than duplicating.
function maybeAutoSearchAtQuota() {
  if (!state.autoSearch) return;
  const btn = document.getElementById("search-button");
  if (!btn || btn.disabled) return; // quota not reached yet
  state.searchPending = true;
  setAutoStatus("quota reached — searching…");
  window.searchForSeed();
}

/* ------------------------------------------------------------------ */
/* Calibration UI                                                     */
/* ------------------------------------------------------------------ */

function beginCalibration() {
  state.calibrating = true;
  state.corners = [];
  state.homography = null;
  setStatus("Click the 4 corners of the character card: top-left, top-right, bottom-right, bottom-left.");
}

function onRawClick(e) {
  if (!state.calibrating) return;
  const rect = els.rawCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (els.rawCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (els.rawCanvas.height / rect.height);
  state.corners.push([x, y]);
  if (state.corners.length === 4) {
    state.calibrating = false;
    saveCorners();
    rebuildHomography();
    setStatus("Calibrated. Rectified preview is live.");
  }
}

/* ------------------------------------------------------------------ */
/* Template capture                                                   */
/* ------------------------------------------------------------------ */

function captureTemplate() {
  if (!state.homography || !state.lastRectImageData) {
    setStatus("Nothing to capture yet — start the camera and calibrate first.");
    return;
  }
  if (state.collecting) return; // already sampling
  const key = els.charSelect.value; // character index (as string) or EMPTY_KEY
  state.collecting = {
    key,
    remaining: SAMPLES_PER_TEMPLATE,
    total: SAMPLES_PER_TEMPLATE,
    sum: new Float32Array(FEATURE_LEN),
  };
  els.captureTemplateBtn.disabled = true;
  setStatus(`Hold ${labelForKey(key)} steady on the card… sampling 0/${SAMPLES_PER_TEMPLATE}`);
}

// Called once per frame while a capture is in progress: accumulate the
// current thumbnail, then finalize (average) once enough frames are in.
function collectSample() {
  const c = state.collecting;
  const thumb = makeThumbnail(state.lastRectImageData);
  for (let i = 0; i < thumb.length; i++) c.sum[i] += thumb[i];
  c.remaining--;
  const got = c.total - c.remaining;
  setStatus(`Hold ${labelForKey(c.key)} steady on the card… sampling ${got}/${c.total}`);
  if (c.remaining <= 0) finalizeCollection();
}

function finalizeCollection() {
  const c = state.collecting;
  const avg = new Uint8ClampedArray(FEATURE_LEN);
  for (let i = 0; i < FEATURE_LEN; i++) avg[i] = c.sum[i] / c.total;
  state.templates[c.key] = avg;
  state.templateFeatures[c.key] = normalizeFeature(avg);
  saveTemplates();
  state.collecting = null;
  els.captureTemplateBtn.disabled = false;
  const charCount = Object.keys(state.templates).filter((k) => k !== EMPTY_KEY).length;
  const hasEmpty = EMPTY_KEY in state.templates;
  setStatus(
    `Captured ${labelForKey(c.key)} (averaged ${c.total} frames). ` +
    `${charCount}/25 characters${hasEmpty ? " + empty" : ""} taught.`
  );
}

/* ------------------------------------------------------------------ */
/* Status helper + init                                               */
/* ------------------------------------------------------------------ */

function setStatus(msg) { els.status.textContent = msg; }

function populateCharSelect() {
  const emptyOpt = document.createElement("option");
  emptyOpt.value = EMPTY_KEY;
  emptyOpt.textContent = "— deselected / empty card —";
  els.charSelect.appendChild(emptyOpt);
  CHARACTER_NAMES.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = name;
    els.charSelect.appendChild(opt);
  });
}

// Bridge to the seed app: a successful search fills #seed-span with "0x…"
// (see processSeed in script.js) — that's our cue to stop recording and let
// the run be performed. Reset means the user wants to locate again.
function watchAppState() {
  const span = document.getElementById("seed-span");
  if (span) {
    const obs = new MutationObserver(() => {
      const txt = (span.textContent || "").trim();
      state.searchPending = false;
      if (!state.autoEntry) return;
      if (txt.startsWith("0x")) enterExecuting();
      // "Not Found" / empty => the app resets; stay in locating.
    });
    obs.observe(span, { childList: true, characterData: true, subtree: true });
  }

  const resetBtn = document.getElementById("reset-button");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (state.autoEntry) enterLocating("reset — recording for a new seed");
    });
  }
}

function init() {
  els = {
    panel: document.getElementById("capture-panel"),
    toggle: document.getElementById("capture-toggle"),
    body: document.getElementById("capture-body"),
    deviceSelect: document.getElementById("capture-device"),
    startBtn: document.getElementById("capture-start"),
    stopBtn: document.getElementById("capture-stop"),
    calibrateBtn: document.getElementById("capture-calibrate"),
    rawCanvas: document.getElementById("capture-raw"),
    rectCanvas: document.getElementById("capture-rect"),
    stabilityBar: document.getElementById("capture-stability-bar"),
    stabilityLabel: document.getElementById("capture-stability-label"),
    charSelect: document.getElementById("capture-char"),
    captureTemplateBtn: document.getElementById("capture-template"),
    matchLabel: document.getElementById("capture-match"),
    autoEntryCheckbox: document.getElementById("capture-auto-entry"),
    autoSearchCheckbox: document.getElementById("capture-auto-search"),
    autoStatus: document.getElementById("capture-auto-status"),
    modeBadge: document.getElementById("capture-mode"),
    status: document.getElementById("capture-status"),
  };
  if (!els.panel) return; // panel not present

  els.rectCanvas.width = RECT_W;
  els.rectCanvas.height = RECT_H;

  populateCharSelect();
  rebuildHomography();
  rebuildTemplateFeatures();

  els.toggle.addEventListener("click", () => els.body.classList.toggle("none"));
  els.startBtn.addEventListener("click", startCamera);
  els.stopBtn.addEventListener("click", stopCamera);
  els.calibrateBtn.addEventListener("click", beginCalibration);
  els.rawCanvas.addEventListener("click", onRawClick);
  els.captureTemplateBtn.addEventListener("click", captureTemplate);
  els.autoEntryCheckbox.addEventListener("change", onAutoEntryToggle);
  els.autoSearchCheckbox.addEventListener("change", onAutoSearchToggle);
  watchAppState();

  // Pre-list devices (labels appear after permission is granted).
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) listDevices();

  const templateCount = Object.keys(state.templates).filter((k) => k !== EMPTY_KEY).length;
  const hasEmpty = EMPTY_KEY in state.templates;
  setStatus(
    state.corners
      ? `Ready. Calibration loaded, ${templateCount}/25 characters${hasEmpty ? " + empty" : ""} taught. Start the camera.`
      : "Ready. Start the camera, then Calibrate."
  );
}

init();
