"""Dump python-reference (charrss.py cvp_search) anchors for a set of random
9-char sequences, so the Node differential test can compare the JS engine's
output directly.

Builds the CVP lattice + Gram-Schmidt once and writes JSON:
[{u, chars, anchors}].
"""
import json
import os
import random
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)
import charrss as cr

NUM_CHARS = 9
COUNT = int(sys.argv[1]) if len(sys.argv) > 1 else 200
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PROJECT_ROOT, "temp", "charrss_anchors.json")


def main():
    R = cr.cvp_basis(NUM_CHARS)
    prep = cr.cvp_prepare(R)
    rng = random.Random(99)
    rows = []

    # structured edge cases first: char0 == 0 / 24
    edge_anchors = []
    for v in (0, 24):
        lo, _ = cr.get_l_and_u_bounds(v)
        edge_anchors.append(lo + 1)
    for u in edge_anchors:
        chars = cr.generate_chars(u, NUM_CHARS)
        rows.append({"u": u, "chars": chars, "anchors": cr.cvp_search(chars, prep)})

    for _ in range(COUNT):
        u = rng.randrange(cr.SIZE)
        chars = cr.generate_chars(u, NUM_CHARS)
        rows.append({"u": u, "chars": chars, "anchors": cr.cvp_search(chars, prep)})

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(rows, f)
    print(f"wrote {len(rows)} rows -> {OUT}")


if __name__ == "__main__":
    main()
