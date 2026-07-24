#!/usr/bin/env python3
"""Report RNG consumption at Peach vegetable pulls in an m-protocol trace."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

A = 214013
C = 2531011
MASK = 0xFFFFFFFF
PULL_ACTION_STATE = 352


def advance(seed: int) -> int:
    return (A * seed + C) & MASK


def roll_distance(start: int, target: int, maximum: int = 20000) -> int:
    seed = start
    for distance in range(maximum + 1):
        if seed == target:
            return distance
        seed = advance(seed)
    return -1


def parse_seed(value: str) -> int:
    return int(value, 0) & MASK


@dataclass(frozen=True)
class Sample:
    timestamp: str
    tick: int | None
    port: int
    frame: int
    seed: int
    targets: int | None
    action_state: int
    action_frame: float | None


@dataclass(frozen=True)
class Pull:
    attempt: int
    number: int
    port: int
    detected: Sample
    transition_frame: int
    boundary: Sample
    previous_frame: Sample | None
    distance: int
    previous_distance: int
    entry_rolls: int


def iter_messages(lines: Iterable[str]) -> Iterable[tuple[str, dict[str, Any]]]:
    for line_number, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            timestamp, raw = line.split("\\t", 1)
            yield timestamp, json.loads(raw)
        except (ValueError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid trace line {line_number}: {exc}") from exc


def find_pulls(lines: Iterable[str], post_bomb_seed: int, port: int = 0) -> list[Pull]:
    values: dict[str, Any] = {}
    samples: list[Sample] = []
    previous_states: dict[int, int | None] = {p: None for p in range(1, 5)}
    pull_counts: dict[int, int] = {p: 0 for p in range(1, 5)}
    pulls: list[Pull] = []
    attempt = 0
    last_frame: int | None = None
    last_targets: int | None = None

    for timestamp, message in iter_messages(lines):
        changed = message.get("values")
        if not isinstance(changed, dict):
            continue
        values.update(changed)
        frame = values.get("frame")
        seed = values.get("match.random_seed")
        if not isinstance(frame, int) or not isinstance(seed, int):
            continue

        targets = values.get("stage.btargets.remaining")
        targets = targets if isinstance(targets, int) else None
        rewound = last_frame is not None and frame < last_frame
        stage_entered = targets == 10 and (last_targets != 10 or rewound)
        if rewound or stage_entered:
            # Save-state restores rewind the in-game frame counter. Entering a
            # fresh BTT stage also resets targets to ten. Either boundary must
            # discard samples and pull counts from the failed attempt.
            samples.clear()
            previous_states = {p: None for p in range(1, 5)}
            pull_counts = {p: 0 for p in range(1, 5)}
        if stage_entered:
            attempt += 1
        last_frame = frame
        last_targets = targets

        for player_port in range(1, 5):
            if port and player_port != port:
                continue
            state_key = f"player.{player_port}.entity.action_state"
            frame_key = f"player.{player_port}.entity.action_frame"
            action_state = values.get(state_key)
            action_frame = values.get(frame_key)
            if not isinstance(action_state, int):
                continue

            sample = Sample(
                timestamp=timestamp,
                tick=message.get("tick"),
                port=player_port,
                frame=frame,
                seed=seed & MASK,
                targets=targets,
                action_state=action_state,
                action_frame=float(action_frame)
                if isinstance(action_frame, (int, float))
                else None,
            )
            samples.append(sample)

            previous = previous_states[player_port]
            previous_states[player_port] = action_state
            if action_state != PULL_ACTION_STATE or previous == action_state:
                continue

            back = max(0, round(sample.action_frame or 1) - 1)
            transition_frame = frame - back
            # Samples contain all ports. Select the last same-port sample at or
            # before the action's reconstructed transition frame.
            same_port = [
                candidate for candidate in samples
                if candidate.frame <= transition_frame
                and candidate.port == player_port
            ]
            boundary = same_port[-1] if same_port else sample
            previous_frame = next(
                (candidate for candidate in reversed(samples)
                 if candidate.port == player_port
                 and candidate.frame < transition_frame),
                None,
            )
            pull_counts[player_port] += 1
            pulls.append(Pull(
                attempt=max(attempt, 1),
                number=pull_counts[player_port],
                port=player_port,
                detected=sample,
                transition_frame=transition_frame,
                boundary=boundary,
                previous_frame=previous_frame,
                distance=roll_distance(post_bomb_seed, boundary.seed),
                previous_distance=roll_distance(post_bomb_seed, previous_frame.seed)
                if previous_frame else -1,
                entry_rolls=roll_distance(previous_frame.seed, boundary.seed, 20000)
                if previous_frame else -1,
            ))

    return pulls


def format_pull(pull: Pull, sword_offsets: list[int]) -> str:
    nearest = min(sword_offsets, key=lambda value: abs(value - pull.distance)) \
        if sword_offsets and pull.distance >= 0 else None
    distance = str(pull.distance) if pull.distance >= 0 else "> scan limit"
    delta = f", nearest sword {nearest} (delta {pull.distance - nearest:+d})" \
        if nearest is not None else ""
    targets = str(pull.detected.targets) if pull.detected.targets is not None else "unknown"
    before = (
        f", prior_frame={pull.previous_frame.frame}, "
        f"prior_seed=0x{pull.previous_frame.seed:08X}, "
        f"prior_rolls={pull.previous_distance}, entry_rolls={pull.entry_rolls}"
        if pull.previous_frame else ""
    )
    return (
        f"attempt {pull.attempt} pull {pull.number} port {pull.port}: targets={targets}, "
        f"transition_frame={pull.transition_frame}, sampled_frame={pull.boundary.frame}, "
        f"seed=0x{pull.boundary.seed:08X}, rolls_from_post_bomb={distance}{delta}{before}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=Path)
    parser.add_argument("--post-bomb-seed", type=parse_seed, required=True)
    parser.add_argument("--port", type=int, choices=range(1, 5), default=0,
                        help="controller port; default auto-detects all ports")
    parser.add_argument("--sword-offset", type=int, action="append", default=[])
    args = parser.parse_args()

    pulls = find_pulls(args.trace.read_text().splitlines(), args.post_bomb_seed, args.port)
    if not pulls:
        raise SystemExit("no Peach pull transitions (action state 352) found")
    for pull in pulls:
        print(format_pull(pull, args.sword_offset))

    six_target_thirds = [
        pull for pull in pulls if pull.number == 3 and pull.detected.targets == 6
    ]
    if six_target_thirds:
        print("six-target third pull:", format_pull(six_target_thirds[-1], args.sword_offset))
    else:
        print("warning: no third pull observed with exactly 6 targets remaining")


if __name__ == "__main__":
    main()
