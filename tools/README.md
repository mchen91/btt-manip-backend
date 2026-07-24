# Offline tooling

This directory contains offline generation, validation, RNG research, and
Windows capture utilities. Nothing here is required by the published static
site at runtime.

## Character reverse-seed search

The runtime ships baked constants for `docs/js/charrss.js`; these scripts
produce and verify them.

The shipped runtime is a **direct CVP / Hidden-Number-Problem seed reconstruction**
that resolves the seed from **9 characters** (validated 5000/5000, zero false
positives). See [`../RSS_IMPLEMENTATION.md`](../RSS_IMPLEMENTATION.md).

## Regenerate the baked constants

```bash
python3 tools/gen_charrss_constants.py                 # 9-char table (default)
python3 tools/gen_charrss_constants.py --chars 9 --trials 5000
```

Builds the LLL-reduced lattice basis + float Gram-Schmidt data (LLL is exact-rational
and ~1 s), runs a self-test gate (Schnorr-Euchner enumeration over the trials; must be
100% found, zero not-found, zero false positives), and only then writes
`docs/js/charrss_constants.js` with a provenance header.

## High-volume Python RSS validation

```bash
python3 tools/validate_charrss.py          # 5000 random seeds (default)
python3 tools/validate_charrss.py 10000    # custom count
```

Runs `cvp_search` against N random anchors plus structured edge cases (char0=0/24,
boundary seeds), verifying every anchor is recovered with zero false positives.
Useful to re-validate after any change to `charrss.py` without regenerating constants.
Expect `ALL PASS`.

## Differential test the JS port

```bash
# optional: refresh the python-reference cross-check fixture (writes to temp/)
python3 tools/_dump_anchors.py 200

# run the JS harness (Node ESM)
node tools/charrss_difftest.mjs 5000
```

Checks: CHAR_RANGES parity, N random anchors (exact `next^(2N-1)` seed agreement +
zero false positives), edge cases, and a cross-impl comparison of JS vs. `charrss.py`
`cvp_search` anchor sets. Expect `ALL PASS`.

## Python ↔ C++ oracle validation (when the compiled `rng` module is importable)

```bash
python3 tools/validate_cpp_oracle.py          # 2000 random seeds (default)
python3 tools/validate_cpp_oracle.py 5000     # custom count
```

Compares `cvp_search` against the actual C++ `locateCharSequence` (via `api.findSeed`),
verifying `api.findSeed(chars) == next^17(min(cvp_search(chars)))` for every test seed.
Expect `C++ oracle: OK`.

## Tool index

### Reverse-seed search and browser validation

- [`gen_charrss_constants.py`](gen_charrss_constants.py) — offline basis generator + gate (committed tool).
- [`validate_charrss.py`](validate_charrss.py) — high-volume standalone Python RSS validation.
- [`validate_cpp_oracle.py`](validate_cpp_oracle.py) — Python ↔ C++ brute-force oracle cross-validation.
- [`charrss_difftest.mjs`](charrss_difftest.mjs) — Node differential test for [`charrss.js`](../docs/js/charrss.js).
- [`_dump_anchors.py`](_dump_anchors.py) — dumps [`charrss.py`](../charrss.py) `cvp_search` reference anchors to `temp/` for cross-impl.
- [`test_capture_perf.mjs`](test_capture_perf.mjs) — verifies live-capture locating/executing frame-rate constraints and preview suppression.

### Pull model and startup RNG

- [`fit_pull_samples.py`](fit_pull_samples.py) — fits the checked-in browser model from `data/pull-samples.csv`.
- [`scan_startup_seeds.cpp`](scan_startup_seeds.cpp) — exhaustively ranks startup seeds for bomb-to-sword routes.
- [`run_startup_seed_scan.sh`](run_startup_seed_scan.sh) — builds the scanner, writes results, and applies the checked-in RTC calibration.
- [`title_history_rng.py`](title_history_rng.py) — simulates title-screen RNG consumption.
- [`map_btt_seed_to_rtc.py`](map_btt_seed_to_rtc.py) — maps ranked BTT seeds to reachable Dolphin RTC values.
- [`build_btt_startup_profile.py`](build_btt_startup_profile.py) — builds an RTC/BTT calibration profile from probe captures.
- `analyze_*.py` — focused analyzers for title, BTT-startup, and Peach-pull captures.
- `test_*.py` and [`test_pull_probe.mjs`](test_pull_probe.mjs) — unit tests run by `../run_all_tests.sh`.

### Windows capture and diagnosis

- [`monitor_windows_perf.ps1`](monitor_windows_perf.ps1) — samples Windows CPU, GPU engines, memory, and OBS lag summaries for Dolphin/OBS/Edge A/B measurements.
- [`capture_dolphin_frames.ps1`](capture_dolphin_frames.ps1) — captures user-controlled Dolphin presentation traces with PresentMon for frame-pacing diagnosis; a Windows Desktop launcher can invoke it from WSL.
- [`probe_dolphin_responsiveness.ps1`](probe_dolphin_responsiveness.ps1) — measures Dolphin's window-message latency, main-thread load, resources, and injected capture/overlay modules.
- [`watch_dolphin_responsiveness.ps1`](watch_dolphin_responsiveness.ps1) — periodically runs the responsiveness probe and records the transition from responsive to degraded without requiring a known reproduction time.
- [`record_mprotocol_rng.ps1`](record_mprotocol_rng.ps1) and [`title_rng_probe.lua`](title_rng_probe.lua) — capture RNG traces from m-protocol and Dolphin.
