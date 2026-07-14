import assert from "node:assert/strict";

import {
  CAMERA_MODE_EXECUTING,
  CAMERA_MODE_LOCATING,
  applyCameraMode,
  cameraConstraintsForMode,
  shouldDrawPreview,
} from "../docs/js/capture-policy.js";

function fakeTrack() {
  const applied = [];
  let settings = { width: 320, height: 180, frameRate: 60 };
  return {
    applied,
    async applyConstraints(constraints) {
      applied.push(constraints);
      settings = {
        ...settings,
        width: constraints.width.ideal,
        height: constraints.height.ideal,
        frameRate: constraints.frameRate.max,
      };
    },
    getSettings() {
      return { ...settings };
    },
  };
}

const locating = cameraConstraintsForMode(CAMERA_MODE_LOCATING);
assert.deepEqual(locating, {
  width: { ideal: 320 },
  height: { ideal: 180 },
  frameRate: { ideal: 30, max: 30 },
});

const executing = cameraConstraintsForMode(CAMERA_MODE_EXECUTING);
assert.deepEqual(executing, {
  width: { ideal: 320 },
  height: { ideal: 180 },
  frameRate: { ideal: 6, max: 6 },
});

const track = fakeTrack();
assert.deepEqual(await applyCameraMode(track, CAMERA_MODE_LOCATING), {
  width: 320,
  height: 180,
  frameRate: 30,
});
assert.deepEqual(await applyCameraMode(track, CAMERA_MODE_EXECUTING), {
  width: 320,
  height: 180,
  frameRate: 6,
});
assert.deepEqual(await applyCameraMode(track, CAMERA_MODE_LOCATING), {
  width: 320,
  height: 180,
  frameRate: 30,
});
assert.deepEqual(track.applied, [locating, executing, locating]);

assert.equal(shouldDrawPreview(CAMERA_MODE_LOCATING), true);
assert.equal(shouldDrawPreview(CAMERA_MODE_EXECUTING), false);

assert.equal(await applyCameraMode(null, CAMERA_MODE_EXECUTING), null);
assert.equal(await applyCameraMode({}, CAMERA_MODE_EXECUTING), null);

console.log("capture performance policy tests passed");
