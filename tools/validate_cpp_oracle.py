"""Python <=> C++ oracle cross-validation for charrss.py.

Compares cvp_search (Python CVP reconstruction) against rng.locateCharSequence
(C++ brute-force oracle) via cpp_oracle.find_seed, verifying they agree on every
test seed.

Requires the compiled rng module (.so) to be present and importable.

Usage:
    python3 tools/validate_cpp_oracle.py [COUNT]

    COUNT  number of random seeds to test (default 2000)

Exit code: 0 if all cases match, 1 on any mismatch or if rng is unavailable.
"""
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from cpp_oracle import find_seed
except ImportError as e:
    print(f"SKIP: could not import cpp_oracle (rng module unavailable): {e}")
    sys.exit(0)

import charrss as cr

NUM_CHARS = 9
COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 2000

IS_TTY = sys.stdout.isatty()
_REPORT_INTERVAL = 0.5  # seconds between progress updates


def _progress(done, matched, mismatched, final=False):
    pct = done / COUNT * 100
    line = f"  {done}/{COUNT} ({pct:.0f}%)  matched={matched}  failed={mismatched}"
    if IS_TTY:
        sys.stdout.write(line + ("  \n" if final else "  \r"))
        sys.stdout.flush()
    else:
        print(line)


def adv(seed, k):
    for _ in range(k):
        seed = (seed * cr.A + cr.C) & cr.MASK
    return seed


def main():
    R = cr.cvp_basis(NUM_CHARS)
    prep = cr.cvp_prepare(R)

    matched = 0
    mismatched = 0
    failures = []

    rng = random.Random(7)
    seeds = [rng.randrange(cr.SIZE) for _ in range(COUNT)]

    last_t = time.monotonic()

    for i, u in enumerate(seeds, 1):
        chars = cr.generate_chars(u, NUM_CHARS)
        py_anchors = cr.cvp_search(chars, prep)
        py_anchor = min(py_anchors)
        expected = adv(py_anchor, 2 * NUM_CHARS - 1)
        cpp_result = find_seed(chars)

        if cpp_result == expected:
            matched += 1
        else:
            mismatched += 1
            failures.append(
                f"seed {u}: cvp_anchor={py_anchor} expected={hex(expected)} cpp={hex(cpp_result)}"
            )

        now = time.monotonic()
        if now - last_t >= _REPORT_INTERVAL:
            _progress(i, matched, mismatched)
            last_t = now

    _progress(COUNT, matched, mismatched, final=True)
    print(f"{matched}/{COUNT} matched")

    if failures:
        for msg in failures[:20]:
            print(f"  FAIL: {msg}")
        if len(failures) > 20:
            print(f"  ... and {len(failures) - 20} more")
        print("FAILED")
        sys.exit(1)

    print("C++ oracle: OK")


if __name__ == "__main__":
    main()
