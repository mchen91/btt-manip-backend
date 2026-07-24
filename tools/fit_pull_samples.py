#!/usr/bin/env python3
"""Fit the browser pull model from data/pull-samples.csv.

Uses only the Python standard library. The generated JavaScript is checked in
so the static browser app does not need a runtime data-loading/build step.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "data" / "pull-samples.csv"
DEFAULT_OUTPUT = ROOT / "docs" / "js" / "pull-model-data.js"
PULLS = ("early", "late")
MIN_SEEDS_FOR_CALIBRATED_ODDS = 8


def load_samples(path: Path) -> dict[str, dict[str, list[int]]]:
    grouped: dict[str, dict[str, list[int]]] = defaultdict(
        lambda: {pull: [] for pull in PULLS}
    )
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["seed", "pull", "iterations"]:
            raise ValueError("CSV header must be exactly: seed,pull,iterations")
        for line_number, row in enumerate(reader, start=2):
            seed = row["seed"].strip()
            pull = row["pull"].strip().lower()
            raw_iterations = row["iterations"].strip()
            if not seed:
                raise ValueError(f"line {line_number}: seed is empty")
            if pull not in PULLS:
                raise ValueError(
                    f"line {line_number}: pull must be early or late, got {pull!r}"
                )
            try:
                iterations = int(raw_iterations)
            except ValueError as error:
                raise ValueError(
                    f"line {line_number}: iterations must be an integer"
                ) from error
            if iterations <= 0:
                raise ValueError(f"line {line_number}: iterations must be positive")
            grouped[seed][pull].append(iterations)
    return dict(grouped)


def fit_model(grouped: dict[str, dict[str, list[int]]]) -> dict:
    values = {
        pull: [
            value
            for by_pull in grouped.values()
            for value in by_pull[pull]
        ]
        for pull in PULLS
    }
    for pull in PULLS:
        if len(values[pull]) < 2:
            raise ValueError(f"need at least two {pull} samples")

    routes = []
    pooled_numerator = 0.0
    pooled_degrees = 0
    for pull in PULLS:
        sample = values[pull]
        variance = statistics.variance(sample)
        seed_samples = [
            by_pull[pull]
            for by_pull in grouped.values()
            if by_pull[pull]
        ]
        within_numerator = sum(
            sum((value - statistics.mean(seed_sample)) ** 2 for value in seed_sample)
            for seed_sample in seed_samples
        )
        within_degrees = sum(len(seed_sample) - 1 for seed_sample in seed_samples)
        within_variance = (
            within_numerator / within_degrees if within_degrees > 0 else math.nan
        )
        seed_means = [statistics.mean(seed_sample) for seed_sample in seed_samples]
        if len(seed_means) > 1 and math.isfinite(within_variance):
            mean_sampling_variance = statistics.mean(
                within_variance / len(seed_sample) for seed_sample in seed_samples
            )
            between_variance = max(
                0.0,
                statistics.variance(seed_means) - mean_sampling_variance,
            )
        else:
            between_variance = math.nan
        pooled_numerator += (len(sample) - 1) * variance
        pooled_degrees += len(sample) - 1
        routes.append(
            {
                "id": pull,
                "label": pull.capitalize(),
                "mean": statistics.mean(sample),
                "sigma": math.sqrt(variance),
                "n": len(sample),
                "seedCount": len(seed_samples),
                "withinSeedSigma": (
                    math.sqrt(within_variance)
                    if math.isfinite(within_variance)
                    else None
                ),
                "betweenSeedSigma": (
                    math.sqrt(between_variance)
                    if math.isfinite(between_variance)
                    else None
                ),
            }
        )

    seed_ids = sorted(grouped)
    known_seed_ids = [seed for seed in seed_ids if "unknown" not in seed.lower()]
    return {
        "strategy": "choose",
        "searchSigma": 4,
        "sharedSigma": math.sqrt(pooled_numerator / pooled_degrees),
        "sampleCount": sum(len(sample) for sample in values.values()),
        "seedCount": len(seed_ids),
        "knownSeedCount": len(known_seed_ids),
        "minimumSeedsForCalibratedOdds": MIN_SEEDS_FOR_CALIBRATED_ODDS,
        "isPilot": any(
            route["seedCount"] < MIN_SEEDS_FOR_CALIBRATED_ODDS
            for route in routes
        ),
        "routes": routes,
    }


def generate_javascript(model: dict, source: Path) -> str:
    encoded = json.dumps(model, indent=2)
    relative_source = source.relative_to(ROOT)
    return (
        "// Generated by tools/fit_pull_samples.py; do not edit by hand.\n"
        f"// Source: {relative_source.as_posix()}\n"
        f"export const FITTED_PULL_MODEL = Object.freeze({encoded});\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the checked-in generated model is stale",
    )
    args = parser.parse_args()

    grouped = load_samples(args.input)
    model = fit_model(grouped)
    generated = generate_javascript(model, args.input)

    if args.check:
        actual = args.output.read_text(encoding="utf-8") if args.output.exists() else ""
        if actual != generated:
            raise SystemExit(
                f"{args.output.relative_to(ROOT)} is stale; "
                "run python3 tools/fit_pull_samples.py"
            )
    else:
        args.output.write_text(generated, encoding="utf-8")

    print(
        f"{model['sampleCount']} samples across {model['seedCount']} seed IDs "
        f"({model['knownSeedCount']} known)"
    )
    for route in model["routes"]:
        print(
            f"{route['label']:>5}: n={route['n']}, "
            f"seeds={route['seedCount']}, mean={route['mean']:.2f}, "
            f"total sigma={route['sigma']:.2f}"
        )
        if route["betweenSeedSigma"] is not None:
            print(
                f"       within-seed sigma={route['withinSeedSigma']:.2f}, "
                f"estimated between-seed sigma={route['betweenSeedSigma']:.2f}"
            )
    print(f"Shared sigma: {model['sharedSigma']:.2f}")
    if model["isPilot"]:
        print(
            "Status: pilot; absolute odds remain uncalibrated "
            f"until each pull covers at least {MIN_SEEDS_FOR_CALIBRATED_ODDS} seeds"
        )


if __name__ == "__main__":
    main()
