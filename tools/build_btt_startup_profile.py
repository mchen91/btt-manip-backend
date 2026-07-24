#!/usr/bin/env python3
"""Build a calibrated RTC-to-Peach-BTT startup profile from probe CSVs."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from analyze_btt_startup_probe import distance


def latest(path: Path) -> dict[str, str]:
    with path.open(newline="") as source:
        rows = list(csv.DictReader(source))
    if not rows:
        raise ValueError(f"{path} has no capture rows")
    return rows[-1]


def pool(value: str) -> list[int]:
    return [int(part, 16) for part in value.split()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boot-csv", type=Path,
                        help="optional direct post-OSGetTick capture CSV")
    parser.add_argument("--assume-title-is-boot", action="store_true",
                        help="use title start as boot seed (no intervening RNG calls)")
    parser.add_argument("--title-csv", required=True, type=Path)
    parser.add_argument("--btt-csv", required=True, type=Path)
    parser.add_argument("--calibration-time", required=True, type=lambda value: int(value, 0),
                        help="exact Dolphin CustomRTCValue (Unix seconds)")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    title = latest(args.title_csv)
    btt = latest(args.btt_csv)
    title_start = int(title["start_seed"], 16)
    if args.boot_csv is not None:
        boot = latest(args.boot_csv)
        boot_seed = int(boot["boot_seed"], 16)
        boot_host_time = boot["host_time"]
        calibration_source = "direct post-OSGetTick hook"
    elif args.assume_title_is_boot:
        boot_seed = title_start
        boot_host_time = title["host_time"]
        calibration_source = (
            "title-entry seed; decompilation shows no intervening HSD_Rand calls")
    else:
        parser.error("provide --boot-csv or --assume-title-is-boot")
    title_final = int(title["after_history"], 16)
    btt_start = int(btt["stage_loaded_seed"], 16)
    pre_title_calls = distance(boot_seed, title_start)
    title_to_btt_calls = distance(title_final, btt_start)
    sampled_second = int(title["calendar_second"])

    profile = {
        "calibration_seed_hex": f"0x{boot_seed:08x}",
        "calibration_time_unix": args.calibration_time,
        "pre_title_calls": pre_title_calls,
        "title_second_offset_mod_60":
            (sampled_second - args.calibration_time) % 60,
        "character_pool": pool(title["character_pool"]),
        "stage_pool": pool(title["stage_pool"]),
        "current_stage_id": int(title["current_stage_id"]),
        "title_to_btt_calls": title_to_btt_calls,
        "stage_load_calls": 12,
        "calibration_capture": {
            "boot_host_time": boot_host_time,
            "calibration_source": calibration_source,
            "title_host_time": title["host_time"],
            "btt_host_time": btt["host_time"],
            "title_sampled_second": sampled_second,
            "title_start_seed_hex": f"0x{title_start:08x}",
            "title_final_seed_hex": f"0x{title_final:08x}",
            "btt_start_seed_hex": f"0x{btt_start:08x}",
        },
    }
    args.output.write_text(json.dumps(profile, indent=2) + "\n")
    print(f"wrote {args.output}")
    print(f"boot -> title calls: {pre_title_calls}")
    print(f"title sampled second: {sampled_second}")
    print(f"RTC-to-title seconds offset: {profile['title_second_offset_mod_60']}")
    print(f"title -> BTT calls: {title_to_btt_calls}")


if __name__ == "__main__":
    main()
