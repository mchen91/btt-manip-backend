#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
binary="${TMPDIR:-/tmp}/btt-scan-startup-seeds"
output="${1:-$repo_dir/results/startup-seeds-swords-2300-2400.csv}"
threads="${BTT_SCAN_THREADS:-$(getconf _NPROCESSORS_ONLN)}"

c++ -O3 -march=native -std=c++20 -pthread \
  "$repo_dir/tools/scan_startup_seeds.cpp" -o "$binary"
"$binary" --self-test
"$binary" --threads "$threads" --output "$output"

# Convert menu/BTT seeds through title RNG setup before attaching RTC values.
profile="$repo_dir/data/btt-startup-profile.json"
mapping="${output}.rtc.json"
python3 "$repo_dir/tools/map_btt_seed_to_rtc.py" "$output" "$profile" \
  --limit 1000000 --times-per-seed 1 --output "$mapping"
python3 "$repo_dir/tools/enrich_startup_csv_rtc.py" "$output" "$mapping"
