# Character-RSS tooling

Offline generation + tests for the client-side character Reverse Seed Search
(`browser/static/js/charrss.js`). The runtime ships baked constants; these scripts
produce and verify them. Nothing here runs in the browser or per-search.

The shipped runtime is a **direct CVP / Hidden-Number-Problem seed reconstruction**
that resolves the seed from **9 characters** (validated 5000/5000, zero false
positives). See `../CHARRSS_9CHAR_FINDINGS.md`.

## Regenerate the baked constants

```bash
python3 tools/gen_charrss_constants.py                 # 9-char table (default)
python3 tools/gen_charrss_constants.py --chars 9 --trials 5000
```

Builds the LLL-reduced lattice basis + float Gram-Schmidt data (LLL is exact-rational
and ~1 s), runs a self-test gate (Schnorr-Euchner enumeration over the trials; must be
100% found, zero not-found, zero false positives), and only then writes
`browser/static/js/charrss_constants.js` with a provenance header.

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

## Files
- `gen_charrss_constants.py` — offline basis generator + gate (committed tool).
- `validate_charrss.py` — high-volume standalone Python RSS validation.
- `validate_cpp_oracle.py` — Python ↔ C++ brute-force oracle cross-validation.
- `charrss_difftest.mjs` — Node differential test for `charrss.js`.
- `_dump_anchors.py` — dumps `charrss.py` `cvp_search` reference anchors to `temp/` for cross-impl.
