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

## Differential test the JS port

```bash
# optional: refresh the python-reference cross-check fixture
python3 tools/_dump_anchors.py 200 /tmp/charrss_anchors.json

# run the JS harness (Node ESM)
node tools/charrss_difftest.mjs 5000
```

Checks: CHAR_RANGES parity, N random anchors (exact `next^(2N-1)` seed agreement +
zero false positives), edge cases, and a cross-impl comparison of JS vs. `charrss.py`
`cvp_search` anchor sets. Expect `ALL PASS`.

## Real C++ oracle (when the compiled `rng` module is importable)

```bash
python3 - <<'PY'
import random, api, charrss as cr
R = cr.cvp_basis(9); prep = cr.cvp_prepare(R)
adv = lambda s,k: (s if k==0 else adv((s*214013+2531011)&cr.MASK, k-1))
for _ in range(2000):
    u = random.randrange(cr.SIZE); chars = cr.generate_chars(u, 9)
    assert api.findSeed(chars) == adv(min(cr.cvp_search(chars, prep)), 17)
print("C++ oracle: OK")
PY
```

Compares `cvp_search` against the actual C++ `locateCharSequence_` (via `api.findSeed`).

## Files
- `gen_charrss_constants.py` — offline basis generator + gate (committed tool).
- `charrss_difftest.mjs` — Node differential test for `charrss.js`.
- `_dump_anchors.py` — dumps `charrss.py` `cvp_search` reference anchors for cross-impl.
