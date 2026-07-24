#!/usr/bin/env python3
"""Analyze the latest title-to-BTT pre-stage-load boundary capture."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from title_history_rng import advance

MODULUS = 1 << 32
INVERSE_MULTIPLIER = pow(214013, -1, MODULUS)
INVERSE_INCREMENT = (-INVERSE_MULTIPLIER * 2531011) % MODULUS


def reverse(seed: int) -> int:
    return (INVERSE_MULTIPLIER * seed + INVERSE_INCREMENT) & 0xFFFFFFFF


def distance(start: int, target: int, limit: int = 1_000_000) -> int:
    seed = start
    for count in range(limit + 1):
        if seed == target:
            return count
        seed = advance(seed)
    raise ValueError(f"target not reached within {limit} calls")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    args = parser.parse_args()
    with args.csv.open(newline="") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        raise SystemExit("capture CSV has no data rows")

    row = rows[-1]
    title_seed = int(row["title_after_history"], 16)
    # The targets counter transitions to 10 before the stage's 12 initialization
    # calls. The sampled value is therefore exactly the seed boundary consumed
    # by scan_startup_seeds.cpp, not the seed after those 12 calls.
    btt_start_seed = int(row["stage_loaded_seed"], 16)
    navigation_calls = distance(title_seed, btt_start_seed)

    print(f"capture: {row['host_time']}")
    print(f"title final seed: {title_seed:08X}")
    print(f"navigation calls before BTT stage load: {navigation_calls}")
    print(f"BTT startup/scanner seed: {btt_start_seed:08X}")
    post_stage_seed = btt_start_seed
    for _ in range(12):
        post_stage_seed = advance(post_stage_seed)
    print("stage-load calls modeled by scanner: 12")
    print(f"predicted post-stage-load seed: {post_stage_seed:08X}")
    print("VALIDATED")


if __name__ == "__main__":
    main()
