#!/usr/bin/env python3
"""Map ranked startup seeds to Dolphin Custom RTC values after one calibration.

Dolphin's GameCube timebase advances at 40.5 MHz and CustomRTCValue has
whole-second resolution.  If seed C was observed at startup with RTC value T,
a target seed S is reachable with the same boot configuration exactly when

    40_500_000 * (target_time - T) == S - C  (mod 2**32).

The coefficient has gcd 32 with 2**32, so only targets with the same low five
bits as the calibration seed are reachable by changing whole seconds alone.
This tool filters the scanner CSV accordingly and emits the best reachable
seeds plus nearby RTC timestamps.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
from pathlib import Path

TICKS_PER_SECOND = 40_500_000
MODULUS = 1 << 32
GCD = 32
REDUCED_MODULUS = MODULUS // GCD
REDUCED_TICKS = TICKS_PER_SECOND // GCD
SECONDS_PERIOD = REDUCED_MODULUS  # about 4.25 years
INVERSE_TICKS = pow(REDUCED_TICKS, -1, REDUCED_MODULUS)


def integer(value: str) -> int:
    return int(value, 0)


def parse_timestamp(value: str) -> int:
    try:
        return integer(value)
    except ValueError:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.astimezone()
        return int(parsed.timestamp())


def iso_local(timestamp: int) -> str:
    return dt.datetime.fromtimestamp(timestamp).astimezone().isoformat(timespec="seconds")


def rtc_solutions(calibration_seed: int, calibration_time: int, target_seed: int,
                  center_time: int, count: int) -> list[int]:
    difference = (target_seed - calibration_seed) % MODULUS
    if difference % GCD:
        return []
    delta = ((difference // GCD) * INVERSE_TICKS) % REDUCED_MODULUS
    base = calibration_time + delta
    nearest_period = round((center_time - base) / SECONDS_PERIOD)
    radius = max(count, 1)
    candidates = [base + (nearest_period + n) * SECONDS_PERIOD
                  for n in range(-radius, radius + 1)]
    candidates.sort(key=lambda value: (abs(value - center_time), value))
    return sorted(candidates[:count])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path, help="CSV from scan_startup_seeds")
    parser.add_argument("--calibration-seed", required=True, type=integer,
                        help="startup seed observed with the calibration RTC")
    parser.add_argument("--calibration-time", required=True, type=parse_timestamp,
                        help="CustomRTCValue (Unix seconds) or ISO-8601 datetime")
    parser.add_argument("--calibration-label", default="",
                        help="boot/emulator configuration recorded in the JSON")
    parser.add_argument("--center-time", type=parse_timestamp,
                        default=int(dt.datetime.now().timestamp()),
                        help="choose equivalent RTC solutions near this time (default now)")
    parser.add_argument("--limit", type=int, default=10,
                        help="number of best reachable seeds to emit")
    parser.add_argument("--times-per-seed", type=int, default=3,
                        help="equivalent RTC timestamps to emit per seed")
    parser.add_argument("--output", type=Path,
                        help="JSON output path (default RESULTS.reachable.json)")
    args = parser.parse_args()

    calibration_seed = args.calibration_seed & 0xFFFFFFFF
    rows: list[dict[str, object]] = []
    with args.results.open(newline="") as source:
        for row in csv.DictReader(source):
            seed = integer(row["seed_hex"]) & 0xFFFFFFFF
            if (seed - calibration_seed) % GCD:
                continue
            rows.append({
                "seed": seed,
                "seed_hex": f"0x{seed:08x}",
                "post_bomb_seed_hex": row["post_bomb_seed_hex"],
                "sword_count": int(row["sword_count"]),
                "sword_offsets": [int(value) for value in row["sword_offsets"].split()],
            })

    rows.sort(key=lambda row: (-int(row["sword_count"]), int(row["seed"])))
    selected = rows[:args.limit]
    for row in selected:
        timestamps = rtc_solutions(
            calibration_seed, args.calibration_time, int(row["seed"]),
            args.center_time, args.times_per_seed)
        row["rtc_values"] = [
            {"unix": timestamp, "hex": f"0x{timestamp:x}", "local_time": iso_local(timestamp)}
            for timestamp in timestamps
        ]
        del row["seed"]

    output = args.output or Path(str(args.results) + ".reachable.json")
    payload = {
        "calibration_seed_hex": f"0x{calibration_seed:08x}",
        "calibration_time_unix": args.calibration_time,
        "calibration_time_local": iso_local(args.calibration_time),
        "calibration_label": args.calibration_label,
        "reachable_seed_residue_mod_32": calibration_seed % GCD,
        "rtc_solution_period_seconds": SECONDS_PERIOD,
        "rtc_solution_period_days": SECONDS_PERIOD / 86400,
        "matching_recorded_seeds": len(rows),
        "results": selected,
    }
    output.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {output} ({len(selected)} of {len(rows)} reachable ranked seeds)")


if __name__ == "__main__":
    main()
