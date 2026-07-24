#!/usr/bin/env python3
"""Validate and explain the latest title_rng_probe_v2.csv capture."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from title_history_rng import simulate


def parse_pool(value: str) -> list[int]:
    return [int(part, 16) for part in value.split()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    args = parser.parse_args()
    with args.csv.open(newline="") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        raise SystemExit("capture CSV has no data rows")

    row = rows[-1]
    result = simulate(
        int(row["after_seconds"], 16),
        parse_pool(row["character_pool"]),
        parse_pool(row["stage_pool"]),
        int(row["current_stage_id"]),
    )
    expected_seed = int(row["after_history"], 16)
    expected_calls = int(row["history_calls"])
    if result.final_seed != expected_seed or result.total_calls != expected_calls:
        raise SystemExit(
            f"MISMATCH predicted {result.final_seed:08X}/{result.total_calls}, "
            f"captured {expected_seed:08X}/{expected_calls}")

    print(f"capture: {row['host_time']}")
    print(f"history seed: {result.initial_seed:08X} -> {result.final_seed:08X}")
    print(f"character calls: {result.character_calls} "
          f"({result.character_rejections} rejected)")
    print(f"slot calls: {result.slot_calls} ({result.slot_rejections} rejected)")
    print(f"stage calls: {result.stage_calls} ({result.stage_rejections} rejected)")
    print("final fixed call: 1")
    print(f"total: {result.total_calls}")
    print("VALIDATED")


if __name__ == "__main__":
    main()
