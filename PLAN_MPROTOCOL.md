# m-protocol data collection + scored sword targeting

> **Status (2026-07-10):** Implemented and verified headlessly + in-browser on
> macOS (no daemon available there). Remaining work is live validation on the
> Windows Dolphin machine — see [`WINDOWS_AGENT.md`](WINDOWS_AGENT.md).

## Context

The user grinds Peach BTT attempts needing a bomb at pull 1 (0.00s), a mandatory turnip pull (~1.30s), and a beam sword at the third pull slot (~2.97s). The app currently manips only the bomb; the sword is ~1/768 luck per attempt. A sword-targeting mode (`targetprey`) exists on `main` (Konami-hidden) but its delay (2246) disagrees with the measured value (1899, `peach-sword-alt`), and it commits to the first candidate seed regardless of where the sword lands in the probability window.

Run RNG consumption between the bomb pull and the sword slot is ~N(1899, 36²) from year-old data. The bomb's explosion triggers a variable number of animation rolls, so relocate-based measurement can't separate that variance out. The fix: **m-protocol** (github.com/gainge/m-protocol, cloned to scratchpad for reference) — a local Windows daemon that reads Dolphin/Melee memory and streams typed paths over WebSocket on `127.0.0.1:43501`. It exposes `match.random_seed` (0x804D5F90 — the exact LCG value the webapp models), the global `frame` counter, and `player.N.entity.action_state` / `action_frame`. Reading the seed at the sword-slot pull frame measures per-attempt consumption **exactly**.

**Rule boundary (user-specified, must be structurally enforced):** memory data may tune the model that plans *future* runs (mean/σ), but must never assist the *current* run. The daemon module is therefore strictly passive — it never writes into the seed engine, never locates/verifies seeds for play, and the camera+rolls flow remains the only manip path. No live-seed assist, no daemon-driven desync checking.

Two features, A feeds B:

- **A. Passive m-protocol data collection**: exact consumption measurement at the pull frames.
- **B. Scored sword targeting**: rework `targetprey` to enumerate nearby candidates and score true sword-hit probability using the measured model.

Expected outcome: sword odds go from ~1/768 per attempt to ~1/100–150 (calibrated + scored), with visible 1-in-N estimates to verify it's real.

## Feature A: m-protocol data collection (new module)

**Files**: new `docs/js/m-protocol.js` (vendored from m-protocol `web/m-protocol.js`, 548 lines, no build step — add attribution header; repo has no LICENSE, user should confirm with gainge), new `docs/js/datacollect.js`, panel markup in `docs/index.html` + styles in `docs/css/style.css`.

**Connection**: `MProtocol` client, subscribe `["frame", "match.random_seed", "player.1.entity.action_state", "player.1.entity.action_frame", "menu.major", "match.paused"]`. Auto-reconnect is built into the client. Panel shows connection state; module is inert when the daemon is absent (page works exactly as today).

**Per-poll rolling buffer** (~10s): `{ frame, seed, actionState, actionFrame }` from each delta. Entries carry the same-poll frame+seed pairing, so seed-at-frame lookups are exact.

**Pull detection**:
- Peach's vegetable-pull action state is character-specific (id > 340, not in the daemon's lookups table). One-time **"learn pull state"** button: user performs a pull in-game; module records the action-state id that appears; persist to localStorage.
- On transition into the pull state, back-correct to the exact transition frame using `action_frame` (resets to 1 on transition): transition frame = poll frame − (actionFrame − 1); read the seed for that frame from the buffer.
- Count pulls per run (run boundary = seed discontinuity off the recent orbit / menu.major change): pull 1 = bomb, pull 2 = turnip, pull 3 = sword slot.

**Measurement**: consumption `C = rollDistance(postBombSeed → seedAtPull3Frame)`, computed by stepping `rngAdv` (import from `docs/js/util.js`; bounded ~50k steps). `postBombSeed` = the manip target event seed advanced 14 rolls (DelayEvent(12) + two IntEvent advances) — script.js exposes the last search's target for read-only use; fallback when no target is known: measured seed at the pull-1 frame. Pull-3 outcome (sword / bomb / turnip+face) is **computed from its seed** — fully passive, no manual input.

**Storage & stats**: append `{ ts, c, outcome }` to localStorage `manip.rundata.v2` (cap ~1000 attempts; optional per-frame roll-rate curve behind a debug flag for variance decomposition, capped tighter). Stats panel: n, mean, σ, min/max, histogram sparkline, clear + export-JSON buttons.

**Model interface**: `getRunModel()` → `{ mean, sigma, n }` — measured values when `n >= 20`, else fallback `{ 1899, 36 }`. Display which model is active.

## Feature B: Scored sword targeting

**[docs/js/event.js](docs/js/event.js)** — new `findScoredCandidates(startSeed, { mean, sigma, horizon, maxCandidates })`:
- Iterate seeds forward from `startSeed` (same loop shape as `searchForEvent`) finding bomb candidates: DelayEvent(12) → IntEvent(128,0,0) → IntEvent(6,0,1).
- For each candidate, from its post-bomb seed scan offsets `[mean − 4σ, mean + 4σ]`, collecting **all** offsets where IntEvent(128,0,0) + IntEvent(6,5,5) succeeds (the current `RangeEvent` short-circuits on the first).
- Score: `p = Σ_offsets φ((offset − mean)/σ)/σ` (generalizes `calculateSuccessRate` from the `peach-sword-alt` branch).
- Stop at `horizon` (default `PORT_ADVANCE_THRESHOLD` = 5000 rolls) or `maxCandidates` (5). Reuse `rngAdv`/`rngInt`.

**[docs/js/rolls.js](docs/js/rolls.js)** — export `manipTimeFrames(rolls)`: run the existing `findActionSequence` DP, sum `count × action.frames`.

**[docs/js/script.js](docs/js/script.js)** — in `processSeed` when item is `targetprey`:
- Call `findScoredCandidates` with `getRunModel()`.
- Auto-target `argmax p / (overheadFrames + manipTimeFrames(interval))`, fixed overhead ≈ 7s × 60f (measured per-attempt cycle cost).
- Render ranked candidates (interval, est. manip seconds, sword offsets, "~1 in N"); clicking a row retargets via existing `buildActionSequence`/`displayActionSequence` (unchanged).
- Unhide the targetprey radio (remove Konami `#secret` gating in index.html).

Out of scope: `happysquare` (same treatment trivially later), port-advance-distance candidates, any daemon involvement in the live manip path.

## Files touched

- new: `docs/js/m-protocol.js` (vendored), `docs/js/datacollect.js`
- `docs/js/event.js` — candidate enumeration + scoring
- `docs/js/script.js` — model interface, candidate selection/rendering, read-only exposure of the last search target for datacollect
- `docs/js/rolls.js` — manip-time helper export
- `docs/index.html`, `docs/css/style.css` — data-collection panel, candidate list, unhide targetprey
- `docs/js/capture.js` — untouched

## Deployment constraints (document in README)

- Daemon is Windows-only and binds `127.0.0.1` — the browser must run on the Dolphin machine (or use `-listen` for LAN).
- GitHub Pages (https) → `ws://127.0.0.1` works in current Chrome/Firefox (loopback is exempt from mixed-content blocking); local `./run.sh` works regardless. Verify on the user's browser during rollout.

## Verification

1. **Headless scoring check** (scratchpad node script; `docs/js/*.js` import cleanly): verify each returned candidate yields bomb-then-sword at the reported offsets by direct `rngAdv`/`rngInt` simulation; verify `p` equals the φ-sum; verify parity with current `searchForEvent` when a single sword offset exists.
2. **Mock daemon test**: small node WebSocket server in the scratchpad replaying the documented protocol (`hello`/`welcome`/`snapshot`/`delta`) with an LCG-consistent seed stream and scripted action-state transitions; verify datacollect detects pulls, back-corrects frames, computes `C` and outcomes matching constructed truth, and persists/exports correctly.
3. **End-to-end in preview** (`./run.sh` + preview tools, no camera/daemon): manual seed entry → ranked candidates render, action list matches auto-picked candidate; regression `./run_all_tests.sh`.
4. **Live validation on the game rig** (user): run daemon, learn pull state, perform a few manip'd runs; confirm measured `C` values are plausible and the computed pull-3 outcomes match what appeared on screen.
