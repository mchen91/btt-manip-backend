#!/usr/bin/env python3
"""Simulate Melee's gm_801BF128 title-screen RNG consumption.

The function's two sorted pools are state-dependent, so callers provide the
first eight entries of each pool plus the previously selected internal stage.
These are the only pre-existing values that can affect its RNG call count once
the pools have been built.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass

MULTIPLIER = 214013
INCREMENT = 2531011
MASK = 0xFFFFFFFF

# gm_801641CC: random-stage index -> InternalStageId (first 29 entries).
STAGE_IDS = (
    4, 5, 13, 6, 8, 2, 7, 3, 10, 9, 25, 19, 11, 12, 14,
    15, 16, 17, 22, 23, 24, 18, 20, 27, 31, 32, 28, 29, 30,
)


@dataclass(frozen=True)
class TitleHistoryResult:
    initial_seed: int
    final_seed: int
    total_calls: int
    character_calls: int
    character_rejections: int
    first_slot: int
    second_slot: int
    slot_calls: int
    slot_rejections: int
    stage_index: int
    stage_id: int
    stage_calls: int
    stage_rejections: int
    final_choice: int


def advance(seed: int) -> int:
    return (seed * MULTIPLIER + INCREMENT) & MASK


def randi(seed: int, maximum: int) -> tuple[int, int]:
    seed = advance(seed)
    return seed, (maximum * (seed >> 16)) >> 16


def same_character_choice(left: int, right: int) -> bool:
    """Title mode treats Zelda (0x12) and Sheik (0x13) as duplicates."""
    return left == right or {left, right} == {0x12, 0x13}


def simulate(seed: int, character_pool: list[int], stage_pool: list[int],
             current_stage_id: int) -> TitleHistoryResult:
    if len(character_pool) < 8 or len(stage_pool) < 8:
        raise ValueError("character_pool and stage_pool must each contain at least 8 entries")
    if any(not 0 <= value <= 0x19 for value in character_pool[:8]):
        raise ValueError("character pool entries must be CharacterKind values in [0, 0x19]")
    if any(not 0 <= value < len(STAGE_IDS) for value in stage_pool[:8]):
        raise ValueError("stage pool entries must be random-stage indices in [0, 28]")

    initial_seed = seed & MASK
    seed = initial_seed
    selected_characters: list[int] = []
    character_calls = 0
    while len(selected_characters) < 4:
        seed, pool_index = randi(seed, 8)
        character_calls += 1
        candidate = character_pool[pool_index]
        if any(same_character_choice(candidate, prior)
               for prior in selected_characters):
            continue
        selected_characters.append(candidate)

    seed, first_slot = randi(seed, 4)
    slot_calls = 1
    while True:
        seed, second_slot = randi(seed, 4)
        slot_calls += 1
        if second_slot != first_slot:
            break

    stage_calls = 0
    while True:
        seed, stage_pool_index = randi(seed, 8)
        stage_calls += 1
        stage_index = stage_pool[stage_pool_index]
        stage_id = STAGE_IDS[stage_index]
        if stage_id != current_stage_id:
            break

    seed, final_choice = randi(seed, 4)
    total_calls = character_calls + slot_calls + stage_calls + 1
    return TitleHistoryResult(
        initial_seed=initial_seed,
        final_seed=seed,
        total_calls=total_calls,
        character_calls=character_calls,
        character_rejections=character_calls - 4,
        first_slot=first_slot,
        second_slot=second_slot,
        slot_calls=slot_calls,
        slot_rejections=slot_calls - 2,
        stage_index=stage_index,
        stage_id=stage_id,
        stage_calls=stage_calls,
        stage_rejections=stage_calls - 1,
        final_choice=final_choice,
    )


def parse_int(value: str) -> int:
    return int(value, 0)


def parse_pool(value: str) -> list[int]:
    return [parse_int(part.strip()) for part in value.split(",") if part.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", required=True, type=parse_int)
    parser.add_argument("--characters", required=True, type=parse_pool,
                        help="comma-separated first eight sorted CharacterKind values")
    parser.add_argument("--stages", required=True, type=parse_pool,
                        help="comma-separated first eight sorted random-stage indices")
    parser.add_argument("--current-stage", required=True, type=parse_int,
                        help="previous InternalStageId")
    args = parser.parse_args()

    payload = asdict(simulate(args.seed, args.characters, args.stages,
                              args.current_stage))
    payload["initial_seed_hex"] = f"0x{payload['initial_seed']:08X}"
    payload["final_seed_hex"] = f"0x{payload['final_seed']:08X}"
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
