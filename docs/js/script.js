import { findSeedDifference, formatHex, isInt, isHex, rngAdv, rngInt } from './util.js';
import { MANIP_ACTIONS, PORT_ADVANCE_THRESHOLD, STAGE_LOAD_ACTION, buildActionSequence, manipTimeFrames } from './rolls.js';
import { EVENT_SEARCH_MAX_ITERATIONS, DEFAULT_RUN_MODEL, searchForEvent, findScoredCandidates, buildCharacterEvents, buildPullEventList } from './event.js';

console.log('Version 1.0.1');
/* Constants */
const STOCK_ICONS = [
	"img/DrMarioBlack.png",
	"img/MarioOriginal.png",
	"img/LuigiOriginal.png",
	"img/BowserOriginal.png",
	"img/PeachOriginal.png",
	"img/YoshiOriginal.png",
	"img/DonkeyKongOriginal.png",
	"img/CaptainFalconOriginal.png",
	"img/GanondorfOriginal.png",
	"img/FalcoOriginal.png",
	"img/FoxOriginal.png",
	"img/NessOriginal.png",
	"img/IceClimbersOriginal.png",
	"img/KirbyOriginal.png",
	"img/SamusOriginal.png",
	"img/ZeldaOriginal.png",
	"img/LinkGreen.png",
	"img/YoungLinkGreen.png",
	"img/PichuOriginal.png",
	"img/PikachuOriginal.png",
	"img/JigglyPuffOriginal.png",
	"img/MewtwoOriginal.png",
	"img/Game & Watch Original.png",
	"img/MarthOriginal.png",
	"img/RoyOriginal.png",
];

const CSS_ICONS = [
  [
    "img/css_doc.png",
    "img/css_mario.png",
    "img/css_luigi.png",
    "img/css_bowser.png",
    "img/css_peach.png",
    "img/css_yoshi.png",
    "img/css_dk.png",
    "img/css_falcon.png",
    "img/css_ganon.png",
  ],
  [
    "img/css_falco.png",
    "img/css_fox.png",
    "img/css_ness.png",
    "img/css_ICs.png",
    "img/css_kirby.png",
    "img/css_samus.png",
    "img/css_zelda.png",
    "img/css_link.png",
    "img/css_yl.png",
  ],
  [
    "",
    "img/css_pichu.png",
    "img/css_pika.png",
    "img/css_puff.png",
    "img/css_m2.png",
    "img/css_gnw.png",
    "img/css_marth.png",
    "img/css_roy.png",
    "",
  ],
];

// First search uses the client-side character RSS (charrss.js): a direct CVP /
// Hidden-Number-Problem seed reconstruction that resolves the seed from 9 characters
// (validated 5000/5000, no false positives) -- see charrss_constants.js provenance /
// RSS_IMPLEMENTATION.md.
const FIRST_SEARCH_MAX_CHARS = 9;
const FIRST_SEARCH_MIN_CHARS = 9;
const SUCCESSIVE_SEARCH_MAX_CHARS = 9;
const SUCCESSIVE_SEARCH_MIN_CHARS = 4; // Might need to be 5... lol, we'll test
const MAX_KEY_SEQ_LENGTH = 10;
const KONAMI = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "KeyB",
  "KeyA"
];



/* State Variables */
let charSeq = [];
let isFirstSearch = true;
let lastSeed = -1;
let searchCount = 0;
let keySeq = [];

// Info about the most recent manip target, exposed read-only for the
// m-protocol data collector (datacollect.js). The collector uses
// postPullSeed as the reference point to measure run RNG consumption; it
// never writes back into the seed engine.
let lastTargetInfo = null;

// Non-manip wall-clock cost of one attempt cycle (relocate + reset + run to
// the sword slot), in frames. Used to weigh candidate manip length against
// success rate. Empirical: ~7s per cycle.
const ATTEMPT_OVERHEAD_FRAMES = 7 * 60;

// Run-consumption model for targetprey scoring: measured (from data
// collection) once enough samples exist, else the spreadsheet-era default.
function getRunModel() {
  if (typeof window.getMeasuredRunModel === 'function') {
    const m = window.getMeasuredRunModel();
    if (m && m.n >= 20) return { mean: m.mean, sigma: m.sigma, n: m.n, source: 'measured' };
    if (m) return { ...DEFAULT_RUN_MODEL, source: 'default', measuredN: m.n };
  }
  return { ...DEFAULT_RUN_MODEL, source: 'default' };
}


function reset(forceReset = false) {
  if (forceReset || confirm('Reset current seed and begin new search?')) {
    // Reset state data
    charSeq = [];
    isFirstSearch = true;
    lastSeed = -1;

    // Clear UI
    clearSeq();
    clearResults();
    clearManualSeed();
  }
}

function incrementSearchCount() {
  searchCount++;

  let searchCountSpan = document.getElementById('search-count');
  searchCountSpan.innerHTML = searchCount;
}

function toggleMismatchOptions() {
  // Show or hide mismatch options depending on checkbox state
  let mismatchCheckbox = document.getElementById('mismatch-checkbox');
  let mismatchOptions = document.getElementById('mismatch-control');

  if (mismatchCheckbox.checked) {
    // Show options
    mismatchOptions.classList.remove('none');
  } else {
    // Hide options
    mismatchOptions.classList.add('none');
  }
}

function getManualSeedText() {
  let manualSeedInput = document.getElementById('manual-seed-input');
  let rawText = manualSeedInput.value;

  return rawText.replace(/\s/g, '');
}

function validateManualSeed(seedText) {
  if (!seedText) return false;
  let stripped = seedText.replace(/\s/g, '');

  // Parse int
  let hexString = `0x${stripped}`;
  if (!isHex(hexString)) return false;

  let intVal = parseInt(hexString, 16);

  // Verify within range [0, 2^32 -1]
  let withinRange = (intVal >= 0 && intVal <= 2**32 - 1);

  // should be the last check lol
  return withinRange;

}


function onManualSeedInput(e) {
  // Validate content + enable search accordingly
  let rawText = getManualSeedText();
  let isValidSeed = validateManualSeed(rawText);

  // Update search button state accordingly
  document.getElementById('search-button').disabled = !isValidSeed;
}


function addActionLine(parent, text) {
  let p = document.createElement('p');
  p.classList.add('action-line')
  p.innerHTML = text;

  parent.appendChild(p)
}


function printAction(parent, action, count) {
  addActionLine(parent, `${count} \u00D7 ${action.label} (${action.rolls})`);
}



function displayActionSequence(actionSequence, rolls, seakSpawn) {
  let actionsBlock = document.getElementById('actions');

  let numActions = 0;
  for (let value of actionSequence.values()) {
    numActions += value;
  }

  // Print header
  // addActionLine(actionsBlock, '----------------------------------');
  // addActionLine(actionsBlock, `Achievable in ${numActions} action${numActions == 1 ? '' : 's'}`);
  // addActionLine(actionsBlock, '----------------------------------');
  // addActionLine(actionsBlock, `Manip Stage: [${seakSpawn ? 'SEAK' : 'PEACH'}]`);
  // addActionLine(actionsBlock, `Target: ${rolls} rolls`);
  
  // actionsBlock.appendChild(document.createElement('br'));


  // Always attempt to print the stage loads first if applicable
  if (actionSequence.get(STAGE_LOAD_ACTION)) {
    let key = STAGE_LOAD_ACTION;
    let value = actionSequence.get(STAGE_LOAD_ACTION);
    printAction(actionsBlock, key, value);
  }

  for (let [key, value] of actionSequence.entries()) {
    if (key == STAGE_LOAD_ACTION) continue;
    printAction(actionsBlock, key, value);
  }
}


function createCharIcon(characterIndex) {
  let icon = document.createElement('img');
  icon.classList.add('stock-icon');
  icon.ondragstart = () => false;
  icon.setAttribute('src', STOCK_ICONS[characterIndex]);
  return icon;
}

function appendCharIcon(characterIndex) {
  let parent = document.getElementById('char-seq-container');
  parent.appendChild(createCharIcon(characterIndex));
}

function buildCharIconList() {
  let parent = document.getElementById('char-seq-container');
  parent.innerHTML = '';

  for (let i = 0; i < charSeq.length; i++) {
    parent.appendChild(createCharIcon(charSeq[i]));
  }
}

function updateCharSeqDisplay() {
  let count = document.getElementById('character-count');

  let max = isFirstSearch ? FIRST_SEARCH_MAX_CHARS : SUCCESSIVE_SEARCH_MAX_CHARS;
  let min = isFirstSearch ? FIRST_SEARCH_MIN_CHARS : SUCCESSIVE_SEARCH_MIN_CHARS;

  count.innerHTML = `${charSeq.length}/${min}`;

  // Update color based on state
  count.classList.remove('empty-count');
  count.classList.remove('partial-count');
  count.classList.remove('full-count');

  if (charSeq.length == 0) {
    count.classList.add('empty-count');
  } else if (charSeq.length < min) {
    count.classList.add('partial-count');
  } else {
    count.classList.add('full-count');
  }

  // Also update the button here
  let searchButton = document.getElementById('search-button');
  searchButton.disabled = (charSeq.length < min);
}


function addCharToSeq(characterIndex) {
  // Keep a rolling buffer no longer than the current search's max length.
  let maxChars = isFirstSearch ? FIRST_SEARCH_MAX_CHARS : SUCCESSIVE_SEARCH_MAX_CHARS;
  if (charSeq.length >= maxChars) {
    // pop one off the list!
    charSeq = charSeq.slice(1);
    // Drop the matching (oldest) icon so the DOM stays in sync without a rebuild.
    let parent = document.getElementById('char-seq-container');
    if (parent.firstChild) parent.removeChild(parent.firstChild);
  }

  console.log('adding character: ' + characterIndex);

  // Add to index array
  charSeq.push(characterIndex);

  // Append just the new icon (avoid re-requesting every prior character's image).
  appendCharIcon(characterIndex);

  // Update character count
  updateCharSeqDisplay();

  // Clear manual seed when entering characters
  clearManualSeed();
}

function undoChar() {
  // Remove last char and refresh UI
  charSeq.pop();

  buildCharIconList();
  updateCharSeqDisplay();
}


function clearSeq() {
  charSeq = [];

  let parent = document.getElementById('char-seq-container');
  parent.innerHTML = ""; // Clear that sucka

  // Clear character count
  updateCharSeqDisplay();
}

function clearManualSeed() {
  let manualSeedInput = document.getElementById('manual-seed-input');
  manualSeedInput.value = "";
}

function clearResults() {
  // Clear results display
  document.getElementById('seed-span').innerHTML = '';
  document.getElementById('summary').innerHTML = '';
  document.getElementById('actions').innerHTML = '';
}

function displaySearchResult(parent, searchResult) {
  // parent.appendChild(document.createTextNode('Event Seed: 0x' + formatHex(searchResult.eventSeed)));
  // parent.appendChild(document.createElement('br'));
  // parent.appendChild(document.createTextNode('0x' + formatHex(searchResult.startSeed) + ' => 0x' + formatHex(searchResult.eventSeed)));
  // parent.appendChild(document.createElement('br'));
  // parent.appendChild(document.createTextNode('Interval: ' + searchResult.interval));

  // Log for funsies
  console.log('Event Seed: 0x' + formatHex(searchResult.eventSeed));
  console.log('End Seed: 0x' + formatHex(searchResult.endSeed));
  console.log('Interval: ' + searchResult.interval);
}

function displayPortAdvance(rolls) {
  let actionsBlock = document.getElementById('actions');

  let seconds = rolls / 4833.9;
  if (seconds > 0.25) {
    seconds -= 0.25;
  }
  let minutes = Math.floor(seconds / 60);
  // Update seconds to account for possible minutes
  seconds = seconds % 60;

  let minutesString = `${minutes} minute${minutes >= 2 ? 's' : ''}`;
  let secondsString = `${(seconds - 0.25).toFixed(2)} second${(seconds - 0.25) >= 2 ? 's' : ''}`;
  let duration = `${minutes ? minutesString + ' and ' : ''}${secondsString}`;

  addActionLine(actionsBlock, `Roll count exceeds ${PORT_ADVANCE_THRESHOLD}!`);
  addActionLine(actionsBlock, 'Start manip on the VS CSS');
  addActionLine(actionsBlock, '--------------------------------');
  addActionLine(actionsBlock, `Open two character ports for ${duration} and continue search!`);
}


// Generic single-pull manip: first matching seed wins (bomb / beamsword /
// saturn / stitch / happysquare).
function processGenericPull(seed, summary, mismatch, spawnCondition, selectedItem, seakSpawn) {
  let events = buildPullEventList(mismatch, spawnCondition, selectedItem);
  let searchResult = searchForEvent(events, seed);

  if (!searchResult.success) {
    // Bummer dude
    alert(`Event not found within ${EVENT_SEARCH_MAX_ITERATIONS} seeds`);
    return false;
  }

  displaySearchResult(summary, searchResult);

  let rolls = searchResult.interval;

  // Check for excessively large rolls, should default to CSS
  if (rolls > PORT_ADVANCE_THRESHOLD) {
    // Whew boy
    displayPortAdvance(rolls);
  } else {
    displayActionSequence(buildActionSequence(rolls, seakSpawn), rolls, seakSpawn);
  }

  lastTargetInfo = {
    item: selectedItem,
    eventSeed: searchResult.eventSeed,
    postPullSeed: searchResult.endSeed,
    interval: rolls,
    ts: Date.now(),
  };
  return true;
}

// Scored bomb->sword manip (targetprey): enumerate nearby candidates, score
// each by per-run sword probability under the live consumption model, and
// auto-target the one with the best probability per attempt-second. The
// ranked list stays clickable to retarget manually.
function processTargetprey(seed, summary) {
  const model = getRunModel();
  const candidates = findScoredCandidates(seed, {
    mean: model.mean,
    sigma: model.sigma,
    horizon: PORT_ADVANCE_THRESHOLD,
    maxCandidates: 6,
  });

  if (candidates.length === 0) {
    alert(`No bomb->sword candidate found within ${EVENT_SEARCH_MAX_ITERATIONS} seeds`);
    return false;
  }

  for (const c of candidates) {
    // Past the port-advance threshold the manip is mostly waiting on the CSS
    // at ~4833.9 rolls/s (~80.6 rolls/frame); otherwise cost the action list.
    c.manipFrames = c.interval > PORT_ADVANCE_THRESHOLD ? null : manipTimeFrames(c.interval);
    const costFrames = ATTEMPT_OVERHEAD_FRAMES + (c.manipFrames ?? c.interval / 80.6);
    c.score = c.p / costFrames;
  }
  const ranked = candidates.slice().sort((a, b) => b.score - a.score);

  displayCandidates(summary, ranked, model);
  targetCandidate(ranked[0], model);
  return true;
}

function describeModel(model) {
  const src = model.source === 'measured'
    ? `measured (n=${model.n})`
    : `default${model.measuredN ? ` — only ${model.measuredN} measured samples so far` : ''}`;
  return `Run model: ${src} · mean ${Math.round(model.mean)} · σ ${Number(model.sigma).toFixed(1)}`;
}

function displayCandidates(summary, ranked, model) {
  const modelLine = document.createElement('p');
  modelLine.classList.add('candidate-model');
  modelLine.textContent = describeModel(model);
  summary.appendChild(modelLine);

  const list = document.createElement('div');
  list.id = 'candidate-list';
  ranked.forEach((c, i) => {
    const row = document.createElement('div');
    row.classList.add('candidate-row');
    if (i === 0) row.classList.add('selected');

    const manipStr = c.manipFrames != null
      ? `manip ~${(c.manipFrames / 60).toFixed(1)}s`
      : 'port advance';
    const oneIn = c.p > 0 ? Math.round(1 / c.p) : Infinity;
    const offsetsStr = c.offsets
      .map((o) => `${o - model.mean >= 0 ? '+' : ''}${Math.round(o - model.mean)}`)
      .join(', ');
    row.textContent =
      `${c.interval} rolls · ${manipStr} · sword ${offsetsStr} from center · ~1 in ${oneIn} runs`;

    row.onclick = () => {
      list.querySelectorAll('.candidate-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      targetCandidate(c, model);
    };
    list.appendChild(row);
  });
  summary.appendChild(list);
}

function targetCandidate(c, model) {
  const actionsBlock = document.getElementById('actions');
  actionsBlock.innerHTML = '';
  if (c.interval > PORT_ADVANCE_THRESHOLD) {
    displayPortAdvance(c.interval);
  } else {
    displayActionSequence(buildActionSequence(c.interval, false), c.interval, false);
  }

  lastTargetInfo = {
    item: 'targetprey',
    eventSeed: c.seed,
    postPullSeed: c.postBombSeed,
    interval: c.interval,
    offsets: c.offsets.slice(),
    p: c.p,
    model: { mean: model.mean, sigma: model.sigma, source: model.source },
    ts: Date.now(),
  };
  console.log('Targeting candidate: 0x' + formatHex(c.seed)
    + ' interval ' + c.interval + ' p ' + c.p.toFixed(5));
}

// Found seed, now to search for an event
function processSeed(seed) {
  let seedSpan = document.getElementById('seed-span');

  // Handle success
  if (seed >= 0) {
    // Store result in application state
    lastSeed = seed;

    // Display the Seed
    let seedString = formatHex(seed);
    console.log(seedString);
    seedSpan.innerHTML = '0x' + seedString;

    // Search for target event
    let mismatch = document.getElementById('mismatch-checkbox').checked;
    let spawnCondition = document.querySelector('input[name="spawn"]:checked').value;
    let selectedItem = document.querySelector('input[name="item"]:checked').value;

    const seakSpawn = spawnCondition === 'seak';

    // Clear summary block for result
    let summary = document.getElementById('summary');
    summary.innerHTML = '';

    const found = selectedItem === 'targetprey'
      ? processTargetprey(seed, summary)
      : processGenericPull(seed, summary, mismatch, spawnCondition, selectedItem, seakSpawn);

    if (found) {
      isFirstSearch = false; // Update flag for future searches
      incrementSearchCount(); // Track searches because that's fun :)
    }
  } else {
    clearResults();
    seedSpan.innerHTML = 'Not Found';
    alert('Seed not found');
    reset(true);
  }

  // Clear character sequence + manual entry
  clearSeq();
}



function searchForSeed() {
  // Check for manual seed entry
  let manualSeed = getManualSeedText();
  if (validateManualSeed(manualSeed)) {
    // Search for the seed, lol
    clearResults();
    let seed = parseInt(manualSeed, 16);
    processSeed(seed);
    clearManualSeed();
    return;
  }


  // First search?
  if (isFirstSearch) {
    searchForNewSeed();
    return;
  }

  // Validate char seq length
  if (charSeq.length < SUCCESSIVE_SEARCH_MIN_CHARS) {
    alert('Please enter more characters');
  }
  
  // Do our own search with the char seq!
  let characterEvents = buildCharacterEvents(charSeq);

  // Find next seed using characters + last seed detected
  let searchResult = searchForEvent(characterEvents, lastSeed);

  clearResults();
  if (searchResult.success) {
    // Extract the current seed from the character sequence search
    let seed = searchResult.endSeed;

    processSeed(seed);
  } else {
    alert(`Character sequence not found after searching ${EVENT_SEARCH_MAX_ITERATIONS} seeds`);
  }
}


// Client-side linear RSS -> Promise<seed>. Runs in a module Web Worker so the
// residual search never blocks the UI; falls back to a lazy main-thread import
// where workers are unavailable (e.g. older environments / tests).
function clientSearchForSeed(seq) {
  if (typeof Worker !== 'undefined') {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./charrss_worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data && e.data.error) reject(new Error(e.data.error));
        else resolve(e.data.seed);
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || 'charrss worker error'));
      };
      worker.postMessage({ charSeq: seq });
    });
  }
  return import('./charrss.js').then((m) => m.searchForCharSeed(seq));
}


function searchForNewSeed() {
  // check sequence
  if (charSeq.length < 1) {
    alert('Please enter a character sequence!');
    return;
  } else if (charSeq.length < FIRST_SEARCH_MIN_CHARS) {
    alert(`First character sequence must be at least ${FIRST_SEARCH_MIN_CHARS} characters long!`);
    return;
  }

  // Snapshot the sequence -- processSeed() clears charSeq, and the search is async.
  const seq = charSeq.slice();

  // Disable search during query + indicate searching
  document.getElementById('search-button').disabled = true;
  document.getElementById('seed-span').innerHTML = 'Searching...';

  const handleSeed = (seed) => {
    clearResults();
    if (!isInt(seed)) {
      alert(`Error processing seed: ${seed}`);
    } else {
      processSeed(seed);
    }
  };
  const handleError = (error) => {
    clearResults();
    alert(`Error Executing Search. ${error}`);
    console.log('Search error: ' + error);
    console.log(error);
  };
  const done = () => { document.getElementById('search-button').disabled = false; };

  clientSearchForSeed(seq).then(handleSeed).catch(handleError).finally(done);
}




function buildCSS() {
  let container = document.getElementById('css');

  let count = 0;

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 9; col++) {
      let icon = document.createElement('img');
      icon.classList.add('css-icon');
      icon.ondragstart = () => false;

      if (row == 2 && (col == 0 || col == 8)) {
        // Random space, hide element and move on
        icon.classList.add('hidden');
      } else {
        icon.setAttribute('src', CSS_ICONS[row][col]);
        
        // Set callback
        icon.onclick = (function(n) {
          return () => addCharToSeq(n);
        })(count);

        count++; // Increment 
      }

      container.appendChild(icon);
    }
  }

}

function arrayEquals(arr1, arr2) {
  if (arr1.length !== arr2.length) {
    return false;
  }

  for (let i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i]) {
      return false;
    }
  }

  return true;
}



// build the UI lol
buildCSS();

// Bind seed input event?
let manualSeedInput = document.getElementById('manual-seed-input');
manualSeedInput.addEventListener('input', onManualSeedInput);

window.toggleMismatchOptions = toggleMismatchOptions;
window.searchForSeed = searchForSeed;
window.undoChar = undoChar;
window.clearSeq = clearSeq;
window.reset = reset;

// Seam for the Live Capture module (capture.js). It only ever calls these two
// entry points, exactly as a manual click / Search press would.
window.addCharToSeq = addCharToSeq;
// (searchForSeed already exposed above.)

// Seam for the m-protocol data collector (datacollect.js): read-only info
// about the most recent manip target so it can measure run consumption
// relative to the post-pull seed. Data flows one way — the collector tunes
// the model used for FUTURE searches (via window.getMeasuredRunModel) and
// never feeds memory-derived state into the current run's manip.
window.getLastTargetInfo = () => lastTargetInfo;

addEventListener('keyup', (event) => {
  keySeq.push(event.code)
  if (keySeq.length > MAX_KEY_SEQ_LENGTH) {
    keySeq = keySeq.slice(1);
  }

  if (arrayEquals(keySeq, KONAMI)) {
    document.getElementById('secret').classList.remove('hidden');
    console.log(':targetprey:');
  }

})
