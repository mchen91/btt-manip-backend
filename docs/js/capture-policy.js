export const CAMERA_MODE_LOCATING = "locating";
export const CAMERA_MODE_EXECUTING = "executing";

const CAMERA_WIDTH = 320;
const CAMERA_HEIGHT = 180;
const CAMERA_FPS = Object.freeze({
  [CAMERA_MODE_LOCATING]: 30,
  [CAMERA_MODE_EXECUTING]: 6,
});

export function cameraConstraintsForMode(mode) {
  const frameRate = CAMERA_FPS[mode];
  if (!frameRate) throw new RangeError(`Unknown camera mode: ${mode}`);
  return {
    width: { ideal: CAMERA_WIDTH },
    height: { ideal: CAMERA_HEIGHT },
    frameRate: { ideal: frameRate, max: frameRate },
  };
}

export async function applyCameraMode(track, mode) {
  if (!track || typeof track.applyConstraints !== "function") return null;
  await track.applyConstraints(cameraConstraintsForMode(mode));
  return typeof track.getSettings === "function" ? track.getSettings() : null;
}

export function shouldDrawPreview(mode) {
  return mode !== CAMERA_MODE_EXECUTING;
}
