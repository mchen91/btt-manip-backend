"""Standalone high-volume validation for charrss.py cvp_search.

Runs cvp_search against N random anchors plus a set of structured edge cases and
verifies that every original anchor is recovered with no false positives.

Usage:
    python3 tools/validate_charrss.py [COUNT]

    COUNT  number of random seeds to test (default 5000)

Exit code: 0 if all cases pass, 1 if any failure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import charrss as cr

NUM_CHARS = 9
COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000


def main():
    R = cr.cvp_basis(NUM_CHARS)
    prep = cr.cvp_prepare(R)

    # structured edge cases: char0 extremes + boundary seeds
    edge_seeds = [cr.get_l_and_u_bounds(v)[0] + 1 for v in (0, 24)]
    edge_seeds += [0, 1, 0xFFFFFFFF]

    result = cr.validate_cvp(prep, NUM_CHARS, COUNT, rng_seed=42, extra_seeds=edge_seeds)
    found = result["found"]
    not_found = result["not_found"]
    false_pos = result["false_pos"]
    multi = result["multi"]
    failures = result["failures"]
    total = len(edge_seeds) + COUNT

    print(f"found {found}/{total}, not_found={not_found}, false_pos={false_pos}, multi={multi}")

    if failures:
        for msg in failures[:20]:
            print(f"  FAIL: {msg}")
        if len(failures) > 20:
            print(f"  ... and {len(failures) - 20} more")
        print("FAILED")
        sys.exit(1)

    print("ALL PASS")


if __name__ == "__main__":
    main()
