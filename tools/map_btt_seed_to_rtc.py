#!/usr/bin/env python3
"""Map ranked Peach-BTT seeds through title RNG setup to Dolphin RTC values."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
from pathlib import Path

from title_history_rng import advance, simulate

MODULUS = 1 << 32
TICKS_PER_SECOND = 40_500_000
GAMECUBE_EPOCH_UNIX = 946_684_800  # 2000-01-01T00:00:00Z
RTC_GCD = 32
RTC_PERIOD = MODULUS // RTC_GCD
INVERSE_TICKS = pow(TICKS_PER_SECOND // RTC_GCD, -1, RTC_PERIOD)
INVERSE_MULTIPLIER = pow(214013, -1, MODULUS)
INVERSE_INCREMENT = (-INVERSE_MULTIPLIER * 2531011) % MODULUS


def parse_timestamp(value: str) -> int:
    try:
        return int(value, 0)
    except ValueError:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.astimezone()
        return int(parsed.timestamp())


def local_iso(timestamp: int) -> str:
    return dt.datetime.fromtimestamp(timestamp).astimezone().isoformat(timespec="seconds")


def calendar_second(timestamp: int, second_offset: int = 0) -> int:
    """Seconds field seen by OSGetTime/OSTicksToCalendarTime.

    The GameCube RTC is an unsigned 32-bit count of seconds since 2000. A
    CustomRTC before that epoch underflows instead of behaving like an ordinary
    Unix timestamp; the wrap changes the seconds field by 2**32 mod 60.
    """
    rtc_seconds = (timestamp - GAMECUBE_EPOCH_UNIX) & 0xFFFFFFFF
    return (rtc_seconds + second_offset) % 60


def reverse(seed: int) -> int:
    return (INVERSE_MULTIPLIER * seed + INVERSE_INCREMENT) & 0xFFFFFFFF


def retreat(seed: int, calls: int) -> int:
    for _ in range(calls):
        seed = reverse(seed)
    return seed


def advance_many(seed: int, calls: int) -> int:
    for _ in range(calls):
        seed = advance(seed)
    return seed


def rtc_base(calibration_seed: int, calibration_time: int,
             required_boot_seed: int) -> int | None:
    difference = (required_boot_seed - calibration_seed) % MODULUS
    if difference % RTC_GCD:
        return None
    delta = ((difference // RTC_GCD) * INVERSE_TICKS) % RTC_PERIOD
    return calibration_time + delta


def nearby_matching_times(base: int, center: int, sampled_second: int,
                          second_offset: int, count: int) -> list[int]:
    nearest = round((center - base) / RTC_PERIOD)
    # RTC_PERIOD mod 60 is 8, so 15 consecutive equivalent solutions cover
    # every seconds-field residue reachable from this boot seed. Search a wider
    # symmetric window to obtain the closest requested solutions.
    candidates = []
    for k in range(nearest - 45, nearest + 46):
        timestamp = base + k * RTC_PERIOD
        if calendar_second(timestamp, second_offset) == sampled_second:
            candidates.append(timestamp)
    candidates.sort(key=lambda value: (abs(value - center), value))
    return candidates[:count]


def verify(timestamp: int, calibration_seed: int, calibration_time: int,
           pre_title_calls: int, second_offset: int, character_pool: list[int],
           stage_pool: list[int], current_stage: int, navigation_calls: int,
           target: int) -> bool:
    boot = (calibration_seed + TICKS_PER_SECOND *
            (timestamp - calibration_time)) & 0xFFFFFFFF
    title = advance_many(boot, pre_title_calls)
    second = calendar_second(timestamp, second_offset)
    after_seconds = advance_many(title, second)
    after_history = simulate(after_seconds, character_pool, stage_pool,
                             current_stage).final_seed
    return advance_many(after_history, navigation_calls) == target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("profile", type=Path,
                        help="calibrated startup profile JSON")
    parser.add_argument("--center-time", type=parse_timestamp,
                        default=int(dt.datetime.now().timestamp()))
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--times-per-seed", type=int, default=3)
    parser.add_argument("--max-history-calls", type=int, default=128)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    profile = json.loads(args.profile.read_text())
    calibration_seed = int(profile["calibration_seed_hex"], 0)
    calibration_time = int(profile["calibration_time_unix"])
    pre_title_calls = int(profile["pre_title_calls"])
    second_offset = int(profile["title_second_offset_mod_60"])
    character_pool = [int(value) for value in profile["character_pool"]]
    stage_pool = [int(value) for value in profile["stage_pool"]]
    current_stage = int(profile["current_stage_id"])
    navigation_calls = int(profile["title_to_btt_calls"])

    mapped = []
    with args.results.open(newline="") as source:
        rows = list(csv.DictReader(source))
    rows.sort(key=lambda row: (-int(row["sword_count"]), int(row["seed_hex"], 0)))

    for row in rows:
        target = int(row["seed_hex"], 0)
        desired_after_history = retreat(target, navigation_calls)
        solutions: dict[int, dict[str, int]] = {}
        for history_calls in range(8, args.max_history_calls + 1):
            after_seconds = retreat(desired_after_history, history_calls)
            history = simulate(after_seconds, character_pool, stage_pool, current_stage)
            if history.total_calls != history_calls or history.final_seed != desired_after_history:
                continue
            for sampled_second in range(60):
                title_seed = retreat(after_seconds, sampled_second)
                boot_seed = retreat(title_seed, pre_title_calls)
                base = rtc_base(calibration_seed, calibration_time, boot_seed)
                if base is None:
                    continue
                for timestamp in nearby_matching_times(
                        base, args.center_time, sampled_second, second_offset,
                        args.times_per_seed):
                    if not verify(timestamp, calibration_seed, calibration_time,
                                  pre_title_calls, second_offset, character_pool,
                                  stage_pool, current_stage, navigation_calls, target):
                        raise RuntimeError("internal RTC solution verification failed")
                    solutions[timestamp] = {
                        "sampled_second": sampled_second,
                        "history_calls": history_calls,
                        "boot_seed": boot_seed,
                    }

        if not solutions:
            continue
        ordered = sorted(solutions.items(),
                         key=lambda item: (abs(item[0] - args.center_time), item[0]))
        times = []
        for timestamp, detail in ordered[:args.times_per_seed]:
            times.append({
                "unix": timestamp,
                "hex": f"0x{timestamp:x}",
                "local_time": local_iso(timestamp),
                "sampled_second": detail["sampled_second"],
                "history_calls": detail["history_calls"],
                "boot_seed_hex": f"0x{detail['boot_seed']:08x}",
            })
        mapped.append({
            "seed_hex": row["seed_hex"],
            "post_bomb_seed_hex": row["post_bomb_seed_hex"],
            "sword_count": int(row["sword_count"]),
            "sword_offsets": [int(value) for value in row["sword_offsets"].split()],
            "rtc_values": times,
        })
        if len(mapped) >= args.limit:
            break

    output = args.output or Path(str(args.results) + ".btt-rtc.json")
    payload = {"profile": profile, "results": mapped}
    output.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {output} ({len(mapped)} mapped seeds)")


if __name__ == "__main__":
    main()
