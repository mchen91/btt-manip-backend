import { findSeedDifference, formatHex, isInt, isHex, rngAdv, rngInt } from './util.js';
import { MANIP_ACTIONS, PORT_ADVANCE_THRESHOLD, STAGE_LOAD_ACTION, buildActionSequence } from './rolls.js';
import { EVENT_SEARCH_MAX_ITERATIONS, calculateSuccessRate, searchForEvent, buildCharacterEvents, buildPullEventList } from './event.js';

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
  addActionLine(actionsBlock, '----------------------------------');
  addActionLine(actionsBlock, `Achievable in ${numActions} action${numActions == 1 ? '' : 's'}`);
  addActionLine(actionsBlock, '----------------------------------');
  addActionLine(actionsBlock, `Manip Stage: [${seakSpawn ? 'SEAK' : 'PEACH'}]`);
  addActionLine(actionsBlock, `Target: ${rolls} rolls`);
  
  actionsBlock.appendChild(document.createElement('br'));


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


function buildCharIconList() {
  let parent = document.getElementById('char-seq-container');
  parent.innerHTML = '';

  for (let i = 0; i < charSeq.length; i++) {
    let characterIndex = charSeq[i];

    let icon = document.createElement('img');
    icon.classList.add('stock-icon');
    icon.ondragstart = () => false;
    icon.setAttribute('src', STOCK_ICONS[characterIndex]);

    parent.appendChild(icon);
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
  }

  console.log('adding character: ' + characterIndex);

  // Add to index array
  charSeq.push(characterIndex);

  // Add element to page
  buildCharIconList();

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
  parent.appendChild(document.createTextNode('Event Seed: 0x' + formatHex(searchResult.eventSeed)));
  parent.appendChild(document.createElement('br'));
  parent.appendChild(document.createTextNode('0x' + formatHex(searchResult.startSeed) + ' => 0x' + formatHex(searchResult.eventSeed)));
  parent.appendChild(document.createElement('br'));
  parent.appendChild(document.createTextNode('Interval: ' + searchResult.interval));

  // Display range info if present (e.g., for targetprey/happysquare sword position)
  if (searchResult.rangeInfo) {
    const { rangeOffset, rangeSize } = searchResult.rangeInfo;
    const center = Math.floor(rangeSize / 2);
    const distanceFromCenter = rangeOffset - center;
    const sign = distanceFromCenter >= 0 ? '+' : '';

    const successRate = calculateSuccessRate(rangeOffset, rangeSize);
    const successPercent = (successRate * 100).toFixed(2);
    const expectedRuns = Math.round(1 / successRate);

    const selectedItem = document.querySelector('input[name="item"]:checked')?.value;

    parent.appendChild(document.createElement('br'));
    if (selectedItem === 'targetprey') {
      // Delay is 1899 (see buildPullEventList); + rangeOffset gives total iterations
      const iterations = 1899 + rangeOffset;
      parent.appendChild(document.createTextNode(`Iterations between bomb and sword pull: ${iterations}`));
    } else {
      parent.appendChild(document.createTextNode(`Sword position: ${rangeOffset}/${rangeSize} (${sign}${distanceFromCenter} from center)`));
    }
    parent.appendChild(document.createElement('br'));
    parent.appendChild(document.createTextNode(`Success rate: ${successPercent}% (~1 in ${expectedRuns} runs)`));
  }

  // Log for funsies
  console.log('Event Seed: 0x' + formatHex(searchResult.eventSeed));
  console.log('End Seed: 0x' + formatHex(searchResult.endSeed));
  console.log('Interval: ' + searchResult.interval);
  if (searchResult.rangeInfo) {
    console.log('Range Info:', searchResult.rangeInfo);
  }
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
    let events = buildPullEventList(mismatch, spawnCondition, selectedItem);
    let searchResult = searchForEvent(events, seed);

    const seakSpawn = spawnCondition === 'seak';

    // Clear summary block for result
    let summary = document.getElementById('summary');
    summary.innerHTML = '';

    if (searchResult.success) {
      displaySearchResult(summary, searchResult);

      let rolls = searchResult.interval;

      // Check for excessively large rolls, should default to CSS
      if (rolls > PORT_ADVANCE_THRESHOLD) {
        // Whew boy
        displayPortAdvance(rolls);
      } else {
        let actionSequence = buildActionSequence(rolls, seakSpawn);

        displayActionSequence(actionSequence, rolls, seakSpawn);
      }
      
      isFirstSearch = false; // Update flag for future searches
      incrementSearchCount(); // Track searches because that's fun :)
    } else {
      // Bummer dude
      alert(`Event not found within ${EVENT_SEARCH_MAX_ITERATIONS} seeds`);
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
