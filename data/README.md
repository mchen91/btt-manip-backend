# Pull-consumption samples

Add one completed measurement per line to `pull-samples.csv`:

```csv
seed,pull,iterations
0x12345678,early,1994
0x12345678,late,2317
```

- `seed`: the post-bomb seed used for every repetition in that group. Hex is
  preferred, but any stable identifier is accepted.
- `pull`: exactly `early` or `late`.
- `iterations`: the measured RNG-roll consumption as a positive integer.

Do not select seeds because they have favorable sword offsets. The multi-seed
dataset is intended to estimate how consumption generalizes to an arbitrary
bomb seed, so seeds should be chosen independently of their sword placement.

The original 68 measurements are recorded as `pilot-seed-unknown`. Replace that
identifier with the actual seed if it is available.

After adding measurements, rebuild the browser model and print a summary:

```bash
python3 tools/fit_pull_samples.py
```

The generated model records the total spread for each pull, a shared
within-pull spread used by the initial search, and—once multiple seeds
exist—estimated within-seed and between-seed spreads. Until both pulls contain
measurements from at least eight seed IDs, the UI labels its absolute odds as
a pilot estimate.
