import { FITTED_PULL_MODEL } from './pull-model-data.js';

// Pull-consumption probability model. The scanner only needs the search
// ranges and scorePullOptions(); fitting and distribution details stay here.
const CURRENT_PULL_MODEL = Object.freeze({
  ...FITTED_PULL_MODEL,
  routes: Object.freeze(FITTED_PULL_MODEL.routes.map((route) => Object.freeze({
    ...route,
    observedSigma: route.sigma,
    // The pilot samples do not yet establish different route variances.
    // Pooling them gives a less noisy first estimate.
    sigma: FITTED_PULL_MODEL.sharedSigma,
  }))),
});

// Abramowitz and Stegun 7.1.26. More than sufficient here: one RNG-roll bin
// is roughly 1/32 of a standard deviation.
function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (
    0.254829592
    + t * (-0.284496736
    + t * (1.421413741
    + t * (-1.453152027
    + t * 1.061405429)))
  );
  const erf = sign * (1 - polynomial * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function integerNormalProbability(iterations, route) {
  if (!Number.isInteger(iterations)) return 0;
  if (!route || !Number.isFinite(route.mean) || !(route.sigma > 0)) return 0;
  const upper = (iterations + 0.5 - route.mean) / route.sigma;
  const lower = (iterations - 0.5 - route.mean) / route.sigma;
  return Math.max(0, normalCdf(upper) - normalCdf(lower));
}

function pullSearchRanges(model = CURRENT_PULL_MODEL) {
  const width = model.searchSigma ?? 4;
  return model.routes.map((route) => ({
    id: route.id,
    label: route.label,
    lo: Math.max(0, Math.floor(route.mean - width * route.sigma)),
    hi: Math.ceil(route.mean + width * route.sigma),
  }));
}

function scorePullOptions(offsetsByPull, model = CURRENT_PULL_MODEL) {
  const pulls = model.routes.map((route) => {
    const offsets = [...new Set(offsetsByPull[route.id] ?? [])]
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    const p = offsets.reduce(
      (sum, offset) => sum + integerNormalProbability(offset, route),
      0,
    );
    return { id: route.id, label: route.label, offsets, p };
  });

  const recommended = pulls.reduce(
    (best, pull) => (!best || pull.p > best.p ? pull : best),
    null,
  );
  const p = model.strategy === 'equal'
    ? pulls.reduce((sum, pull) => sum + pull.p, 0) / Math.max(1, pulls.length)
    : (recommended?.p ?? 0);

  return {
    p,
    recommendedPull: recommended?.id ?? null,
    pulls,
  };
}

export {
  CURRENT_PULL_MODEL,
  normalCdf,
  integerNormalProbability,
  pullSearchRanges,
  scorePullOptions,
};
