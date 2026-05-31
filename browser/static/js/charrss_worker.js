// Web Worker wrapper for the client-side character RSS. Runs searchForCharSeed
// off the main thread so the ~0.5-1.5M-check residual never freezes the UI.
// Instantiated as a module worker:  new Worker(url, { type: 'module' }).
import { searchForCharSeed } from './charrss.js';

self.onmessage = (e) => {
  const { charSeq } = e.data;
  try {
    const seed = searchForCharSeed(charSeq);
    self.postMessage({ seed });
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
