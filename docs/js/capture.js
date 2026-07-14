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
 * The video source is an OBS Virtual Camera whose scene is cropped down to
 * just the character card, so the incoming frame is already head-on and
 * axis-aligned. There is nothing to calibrate or rectify: we scale the
 * frame straight into the classification buffer.
 */

import {
  CAMERA_MODE_EXECUTING,
  CAMERA_MODE_LOCATING,
  applyCameraMode,
  cameraConstraintsForMode,
  shouldDrawPreview,
} from "./capture-policy.js";

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
const RECT_W = 160;
const RECT_H = 90;

// Classification feature: a moderate-resolution COLOR thumbnail of the card.
// We let the GPU area-average the video frame straight down to this grid (see
// captureCard), so the per-frame pixel readback is only THUMB_W*THUMB_H — big
// enough and in color to separate 25 characters. Bump to trade CPU for detail.
const THUMB_W = 64;
const THUMB_H = 36;
const FEATURE_LEN = THUMB_W * THUMB_H * 3; // RGB

// --- Auto-entry roll detection ---
// The OBS feed is a clean, static digital image, so we don't infer rolls from
// inter-frame motion; we read the classified label directly. Every roll is
// bracketed by a deselect (the empty card), so that is the delimiter: after an
// empty we "arm", and the next character that classifies confidently for a few
// frames is the roll.
const CONF_MIN = 0.72;       // min cosine similarity to trust the empty delimiter
// Auto-add gate. The best match must both clear a garbage floor and stand out
// from the runner-up by a RELATIVE margin (best - second)/best. Together these
// reject mid-transition frames and the stage during a run (where nothing matches
// well, so a large margin could otherwise appear by chance between two bad ones).
const AUTOADD_FLOOR = 0.55;  // below this the best match is treated as garbage
const AUTOADD_MARGIN = 0.15; // best must beat 2nd-best by this fraction of best
const CONFIRM_FRAMES = 2;    // consecutive confident frames on a character before adding
// Sample rate: we only need to sample fast enough to catch each transient state
// (character shown / deselected). At ~4 rolls/sec those last ~150ms, so 30fps
// (~5 samples/state) is comfortable while cutting the loop's CPU vs the vsync rate.
const SAMPLE_INTERVAL_MS = 1000 / 30;
// While "executing" (performing the run — by far the longest phase, and when
// smooth gameplay/recording matters most) we're not reading characters, only
// waiting for the run to end. That transition is second-scale (OFFCSS_MS), so a
// much slower sample rate is plenty and keeps our CPU out of the way of the run.
const SAMPLE_INTERVAL_EXEC_MS = 1000 / 6;

// Recording mode / run detection. While "executing" (after a successful
// search), we ignore the card entirely until we detect a run has happened:
// during a run the ROI shows the stage, matching no CSS state, so the best
// similarity drops. Sustained low similarity = a run; similarity returning =
// back on the character-select screen -> resume "locating".
const OFFCSS_CONF = 0.50;  // best similarity below this = not a CSS state
const ONCSS_CONF = 0.62;   // best similarity at/above this = a CSS state again
const OFFCSS_MS = 900;     // sustained off-CSS this long = a run occurred

// v3: templates now come from the GPU downscale path (captureCard) rather than
// the old manual area-average, so v2 templates are ignored and must be re-taught.
const STORAGE_KEY_TEMPLATES = "capture.templates.v3";

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

const state = {
  stream: null,
  video: null,
  running: false,
  rafId: null,
  cameraConstraintGeneration: 0,
  cameraSettings: null,

  // Classification templates: { [charIndex]: Uint8ClampedArray(FEATURE_LEN) }
  // = the raw RGB thumbnail. templateFeatures caches the normalized
  // (zero-mean, unit-norm) version used for cosine matching.
  templates: loadTemplates(),
  templateFeatures: {},
  lastThumbPx: null, // current frame's RGB feature (reused buffer, len FEATURE_LEN)
  lastMatch: null, // { key, index, isEmpty, similarity, secondSim }

  // Auto-entry
  autoEntry: false,
  autoSearch: false,
  sawEmptySinceAdd: false, // "armed": card deselected since the last add
  lastAddedIndex: -1, // last character auto-added (identity-change fallback)
  confirmKey: null, // character key currently accumulating confirmation frames
  confirmCount: 0, // consecutive confident frames on confirmKey

  // Recording mode
  recordingMode: CAMERA_MODE_LOCATING, // locating (record rolls) | executing (ignore)
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
/* Camera                                                             */
/* ------------------------------------------------------------------ */

// The OBS Virtual Camera is the intended source; recognise it by label so we
// can auto-select and auto-start on it.
const OBS_LABEL_RE = /OBS Virtual Camera/i;

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
    // Prefer the OBS Virtual Camera whenever it's present (labels are only
    // populated after camera permission is granted).
    const obs = cams.find((c) => OBS_LABEL_RE.test(c.label));
    if (obs) els.deviceSelect.value = obs.deviceId;
    return cams;
  } catch (e) {
    setStatus(`Could not list cameras: ${e.message}`);
    return [];
  }
}

// On load, if the OBS Virtual Camera is available, select it and start
// automatically. Recognising OBS by name needs device labels, which only
// appear after camera permission is granted — so if we don't have labels yet,
// prime a throwaway stream to unlock them, then re-list and start.
async function autoStart() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  let cams = await listDevices();
  if (!cams.some((c) => c.label)) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach((t) => t.stop());
    } catch { return; } // permission denied / no camera — leave manual start
    cams = await listDevices();
  }
  if (cams.some((c) => OBS_LABEL_RE.test(c.label))) startCamera();
}

async function startCamera() {
  try {
    const deviceId = els.deviceSelect.value || undefined;
    // We only ever classify a downscaled RECT_W x RECT_H (then a 64x36 feature)
    // thumbnail, so ask the source for a small frame: even though the OBS
    // Virtual Camera nominally outputs 1080p, requesting a low resolution lets
    // the browser hand us a downscaled track and skip decoding megapixels of a
    // feed whose real detail tops out well below this anyway. 320x180 keeps a
    // 2x supersampling margin over RECT_W x RECT_H at ~1/36 the pixels of 1080p.
    const size = cameraConstraintsForMode(CAMERA_MODE_LOCATING);
    // Keep startup permissive: once the stream is live, applyCameraMode sets a
    // strict maximum. If a camera cannot satisfy that maximum, capture still
    // works and the status line reports that the optimization was rejected.
    size.frameRate = { ideal: size.frameRate.ideal };
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { ...size },
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
    await setCameraMode(effectiveCameraMode());
    loop();
  } catch (e) {
    setStatus(`Camera error: ${e.message}`);
  }
}

function stopCamera() {
  state.running = false;
  state.cameraConstraintGeneration++;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.video = null;
  state.cameraSettings = null;
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  setStatus("Camera stopped.");
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                         */
/* ------------------------------------------------------------------ */

// requestAnimationFrame drives the loop (it pauses when the tab is hidden and
// stays vsync-aligned), but we only do the expensive work — frame readback +
// classify — at SAMPLE_INTERVAL_MS. Skipped ticks are nearly free, so on a
// high-refresh monitor this cuts the loop's CPU proportionally.
let lastSampleTs = 0;
function effectiveCameraMode() {
  return state.autoEntry && state.recordingMode === CAMERA_MODE_EXECUTING
    ? CAMERA_MODE_EXECUTING
    : CAMERA_MODE_LOCATING;
}

function formatCameraSettings(settings) {
  if (!settings) return "delivered settings unavailable";
  const size = settings.width && settings.height
    ? `${settings.width}×${settings.height}`
    : "size unknown";
  const fps = Number.isFinite(settings.frameRate)
    ? `${Math.round(settings.frameRate * 10) / 10} fps`
    : "fps unknown";
  return `${size} @ ${fps}`;
}

async function setCameraMode(mode) {
  const track = state.stream && state.stream.getVideoTracks()[0];
  if (!track) return;
  const generation = ++state.cameraConstraintGeneration;
  try {
    const settings = await applyCameraMode(track, mode);
    if (generation !== state.cameraConstraintGeneration) return;
    state.cameraSettings = settings;
    setStatus(`Camera running: ${formatCameraSettings(settings)} (${mode}).`);
  } catch (e) {
    if (generation !== state.cameraConstraintGeneration) return;
    state.cameraSettings = typeof track.getSettings === "function" ? track.getSettings() : null;
    setStatus(
      `Camera running: ${formatCameraSettings(state.cameraSettings)}. ` +
      `${mode} frame-rate limit unavailable (${e.message}).`,
    );
  }
}

function loop(now) {
  if (!state.running) return;
  state.rafId = requestAnimationFrame(loop);
  const t = now ?? performance.now(); // first call (from startCamera) has no arg
  // Slow the loop right down while a run is being performed; go full rate only
  // when we're actually locating (reading rolls).
  const mode = effectiveCameraMode();
  const interval = mode === CAMERA_MODE_EXECUTING
    ? SAMPLE_INTERVAL_EXEC_MS : SAMPLE_INTERVAL_MS;
  if (t - lastSampleTs < interval) return;
  lastSampleTs = t;
  captureCard(shouldDrawPreview(mode));
  classifyCurrent();
  updateAutoEntry();
}

// Offscreen THUMB_W x THUMB_H canvas: the GPU downscales the video frame into
// it so we only ever read back FEATURE_LEN pixels for classification.
let thumbCanvas = null, thumbCtx = null, previewCtx = null;
function ensureThumbCanvas() {
  if (thumbCtx) return;
  thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = THUMB_W;
  thumbCanvas.height = THUMB_H;
  thumbCtx = thumbCanvas.getContext("2d", { willReadFrequently: true });
  thumbCtx.imageSmoothingEnabled = true;      // area-average on downscale
  thumbCtx.imageSmoothingQuality = "high";
}

// The Virtual Camera feed is already the character card, cropped and axis-aligned
// in OBS, so there is no perspective to undo. Two draws: a cheap preview to the
// visible canvas (no pixel readback), and a hardware downscale straight to the
// THUMB grid, whose tiny readback is the classification feature.
function captureCard(drawPreview) {
  const v = state.video;
  if (!v || !v.videoWidth) return;

  // Preview (display only — never read back).
  if (drawPreview) {
    const pv = els.rawCanvas;
    if (pv.width !== RECT_W || pv.height !== RECT_H) {
      pv.width = RECT_W;
      pv.height = RECT_H;
    }
    if (!previewCtx) previewCtx = pv.getContext("2d");
    previewCtx.drawImage(v, 0, 0, RECT_W, RECT_H);
  }

  // Classification feature: GPU downscale -> small readback -> pack RGB (drop A).
  ensureThumbCanvas();
  thumbCtx.drawImage(v, 0, 0, THUMB_W, THUMB_H);
  const rgba = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
  const px = state.lastThumbPx || (state.lastThumbPx = new Uint8ClampedArray(FEATURE_LEN));
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    px[j] = rgba[i]; px[j + 1] = rgba[i + 1]; px[j + 2] = rgba[i + 2];
  }
}

/* ------------------------------------------------------------------ */
/* Classification (color thumbnail + zero-mean unit-norm cosine)      */
/* ------------------------------------------------------------------ */

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
  if (!state.lastThumbPx) return;
  const keys = Object.keys(state.templateFeatures);
  if (keys.length === 0) {
    els.matchLabel.textContent = "No templates captured yet";
    state.lastMatch = null;
    return;
  }
  const live = normalizeFeature(state.lastThumbPx);
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

// The single status line. It shows the current message and is colour-coded by
// mode (green = recording, orange = run/not-recording) so the state still reads
// at a glance without a separate badge.
function setAutoStatus(msg) {
  if (!els.autoStatus) return;
  els.autoStatus.textContent = msg;
  let cls = "capture-auto-status";
  if (state.autoEntry) {
    cls += state.recordingMode === "executing" ? " mode-exec" : " mode-rec";
  }
  els.autoStatus.className = cls;
}

function onAutoEntryToggle() {
  state.autoEntry = els.autoEntryCheckbox.checked;
  if (state.autoEntry) enterLocating("on — roll a character…");
  else {
    setCameraMode(CAMERA_MODE_LOCATING);
    setAutoStatus("off");
  }
}

function onAutoSearchToggle() {
  state.autoSearch = els.autoSearchCheckbox.checked;
}

// --- Recording-mode transitions ------------------------------------------

function enterExecuting(msg) {
  state.recordingMode = CAMERA_MODE_EXECUTING;
  state.runSeen = false;
  state.offCssSince = 0;
  state.confirmKey = null;
  state.confirmCount = 0;
  setCameraMode(CAMERA_MODE_EXECUTING);
  setAutoStatus(msg || "seed found — recording paused (performing run)");
}

function enterLocating(msg) {
  state.recordingMode = CAMERA_MODE_LOCATING;
  state.runSeen = false;
  state.offCssSince = 0;
  state.searchPending = false;
  state.confirmKey = null;
  state.confirmCount = 0;
  // Require a fresh deselect before the first record, so a character already
  // on the card (e.g. Peach after a run) is never recorded.
  state.lastAddedIndex = -1;
  state.sawEmptySinceAdd = false;
  setCameraMode(CAMERA_MODE_LOCATING);
  if (msg) setAutoStatus(msg);
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

// Per-frame state machine. On a clean feed we read the classified label
// directly: a deselect (empty) arms us, then the next character that classifies
// confidently for CONFIRM_FRAMES consecutive frames is recorded as one roll.
function updateAutoEntry() {
  if (!state.autoEntry) return;

  if (state.recordingMode === CAMERA_MODE_EXECUTING) {
    updateRunTransition(performance.now());
    return;
  }
  if (state.searchPending) return; // a search is resolving; ignore input

  const m = state.lastMatch;
  if (!m) return; // no templates / nothing classified yet

  // Deselect = the delimiter between rolls: arm for the next character and
  // abandon any character confirmation in progress.
  if (m.isEmpty) {
    if (m.similarity >= CONF_MIN) {
      state.sawEmptySinceAdd = true;
      state.confirmKey = null;
      state.confirmCount = 0;
      setAutoStatus("deselected — ready for next roll");
    }
    return;
  }

  // A character frame only counts if it clears the garbage floor and stands
  // clearly apart from the runner-up; otherwise it's a mid-transition frame and
  // we drop any partial confirmation.
  const relMargin = (m.similarity - m.secondSim) / m.similarity;
  if (m.similarity < AUTOADD_FLOOR || relMargin < AUTOADD_MARGIN) {
    state.confirmKey = null;
    state.confirmCount = 0;
    return;
  }

  // Debounce: the same character must hold for CONFIRM_FRAMES consecutive frames
  // before we treat it as landed.
  if (m.key === state.confirmKey) state.confirmCount++;
  else { state.confirmKey = m.key; state.confirmCount = 1; }
  if (state.confirmCount < CONFIRM_FRAMES) return;

  // New-roll gate: a deselect must have separated this from the previous add.
  // The deselect is authoritative; an identity change (a different character
  // than last recorded) also counts, as a fallback if a deselect frame was ever
  // missed -- but only mid-sequence (lastAddedIndex !== -1), so a character
  // already on the card before the first deselect (e.g. Peach after a run) is
  // never recorded. Resting on the character we already recorded does nothing.
  const isNewRoll = state.sawEmptySinceAdd ||
    (state.lastAddedIndex !== -1 && m.index !== state.lastAddedIndex);
  if (!isNewRoll) return;

  window.addCharToSeq(m.index);
  state.lastAddedIndex = m.index;
  state.sawEmptySinceAdd = false;
  state.confirmKey = null;
  state.confirmCount = 0;
  setAutoStatus(`added ${labelForKey(m.key)} (${Math.round(m.similarity * 100)}%)`);
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
/* Template capture                                                   */
/* ------------------------------------------------------------------ */

// The feed is a clean, static digital frame, so a single grab is as good a
// reference as an average — snapshot the current thumbnail straight into the
// template.
function captureTemplate() {
  if (!state.lastThumbPx) {
    setStatus("Nothing to capture yet — start the camera first.");
    return;
  }
  const key = els.charSelect.value; // character index (as string) or EMPTY_KEY
  const thumb = state.lastThumbPx.slice(); // copy: lastThumbPx is reused each frame
  state.templates[key] = thumb;
  state.templateFeatures[key] = normalizeFeature(thumb);
  saveTemplates();
  const charCount = Object.keys(state.templates).filter((k) => k !== EMPTY_KEY).length;
  const hasEmpty = EMPTY_KEY in state.templates;
  setStatus(
    `Captured ${labelForKey(key)}. ` +
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
    rawCanvas: document.getElementById("capture-raw"),
    charSelect: document.getElementById("capture-char"),
    captureTemplateBtn: document.getElementById("capture-template"),
    matchLabel: document.getElementById("capture-match"),
    autoEntryCheckbox: document.getElementById("capture-auto-entry"),
    autoSearchCheckbox: document.getElementById("capture-auto-search"),
    autoStatus: document.getElementById("capture-auto-status"),
    status: document.getElementById("capture-status"),
  };
  if (!els.panel) return; // panel not present

  populateCharSelect();
  rebuildTemplateFeatures();

  els.toggle.addEventListener("click", () => els.body.classList.toggle("none"));
  els.startBtn.addEventListener("click", startCamera);
  els.stopBtn.addEventListener("click", stopCamera);
  els.captureTemplateBtn.addEventListener("click", captureTemplate);
  els.autoEntryCheckbox.addEventListener("change", onAutoEntryToggle);
  els.autoSearchCheckbox.addEventListener("change", onAutoSearchToggle);
  watchAppState();

  // Pre-list devices and auto-start on the OBS Virtual Camera if it's present.
  autoStart();

  const templateCount = Object.keys(state.templates).filter((k) => k !== EMPTY_KEY).length;
  const hasEmpty = EMPTY_KEY in state.templates;
  setStatus(
    `Ready. ${templateCount}/25 characters${hasEmpty ? " + empty" : ""} taught. Start the camera.`
  );
}

init();
