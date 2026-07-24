export const PULL_ACTION_STATE = 352;
export const DEFAULT_POST_BOMB_SEED = 0x4D1DC240;
export const DEFAULT_SWORD_OFFSETS = [2289, 2301, 2328, 2340, 2370];

export function rngAdvance(seed) {
  return ((seed * 214013) + 2531011) >>> 0;
}
export function rollDistance(start, target, maximum = 50000) {
  let seed = start >>> 0;
  target >>>= 0;
  for (let distance = 0; distance <= maximum; distance++) {
    if (seed === target) return distance;
    seed = rngAdvance(seed);
  }
  return -1;
}

export function parseSeed(text) {
  const cleaned = String(text).trim();
  if (!/^(?:0x)?[0-9a-f]{1,8}$/i.test(cleaned)) return null;
  return Number.parseInt(cleaned.replace(/^0x/i, ''), 16) >>> 0;
}

export class PullTracker {
  constructor(baseSeed = DEFAULT_POST_BOMB_SEED) {
    this.baseSeed = baseSeed >>> 0;
    this.attempt = 0;
    this.pullCount = 0;
    this.samples = [];
    this.previousActionState = null;
    this.lastFrame = null;
    this.lastTargets = null;
  }

  setBaseSeed(seed) {
    this.baseSeed = seed >>> 0;
  }

  resetRun() {
    this.pullCount = 0;
    this.samples = [];
    this.previousActionState = null;
  }

  consume(sample) {
    if (!Number.isInteger(sample.frame) || !Number.isInteger(sample.seed)) return null;

    const rewound = this.lastFrame !== null && sample.frame < this.lastFrame;
    const stageEntered = sample.targets === 10 &&
      (this.lastTargets !== 10 || rewound);
    if (rewound || stageEntered) this.resetRun();
    if (stageEntered || (rewound && sample.targets > 0 && sample.targets < 10)) {
      this.attempt++;
    }
    if (this.attempt === 0 && sample.targets > 0) this.attempt = 1;
    this.lastFrame = sample.frame;
    this.lastTargets = sample.targets;

    const normalized = {
      ...sample,
      seed: sample.seed >>> 0,
      actionFrame: Number.isFinite(sample.actionFrame) ? sample.actionFrame : null,
    };
    this.samples.push(normalized);
    if (this.samples.length > 1500) this.samples.shift();

    const previousState = this.previousActionState;
    this.previousActionState = sample.actionState;
    if (sample.actionState !== PULL_ACTION_STATE ||
        previousState === PULL_ACTION_STATE) return null;

    const back = normalized.actionFrame !== null && normalized.actionFrame >= 1
      ? Math.max(0, Math.round(normalized.actionFrame) - 1)
      : 0;
    const transitionFrame = normalized.frame - back;
    const boundary = [...this.samples].reverse()
      .find((candidate) => candidate.frame <= transitionFrame) || normalized;
    const prior = [...this.samples].reverse()
      .find((candidate) => candidate.frame < transitionFrame) || null;

    this.pullCount++;
    const distance = rollDistance(this.baseSeed, boundary.seed);
    const priorDistance = prior ? rollDistance(this.baseSeed, prior.seed) : -1;
    return {
      attempt: this.attempt,
      pull: this.pullCount,
      targets: normalized.targets,
      transitionFrame,
      boundaryFrame: boundary.frame,
      boundarySeed: boundary.seed,
      distance,
      priorFrame: prior?.frame ?? null,
      priorSeed: prior?.seed ?? null,
      priorDistance,
      entryRolls: prior ? rollDistance(prior.seed, boundary.seed, 1000) : -1,
    };
  }
}
