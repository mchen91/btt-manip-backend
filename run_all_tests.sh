#!/usr/bin/env bash
# Run all CharRSS validation tools in the correct order.
#
# Usage:
#   ./run_all_tests.sh [RSS_COUNT]
#
#   RSS_COUNT  random seeds for the Python RSS validation (default 5000)
#
# Requires: Python 3 with fractions, Node (ESM support).
# The C++ oracle step requires the compiled rng.so; it is skipped gracefully if absent.

set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RSS_COUNT="${1:-5000}"
PASS=0
FAIL=0

run_step() {
    local label="$1"; shift
    echo "=== $label ==="
    if "$@"; then
        PASS=$((PASS + 1))
    else
        echo "    FAIL"
        FAIL=$((FAIL + 1))
    fi
    echo ""
}

run_step "[1/10] Pull model data is current" \
    python3 tools/fit_pull_samples.py --check

run_step "[2/10] Python unit tests" \
    python3 -m unittest discover -s tools -p 'test_*.py'

run_step "[3/10] Python RSS validation" \
    python3 tools/validate_charrss.py "$RSS_COUNT"

run_step "[4/10] Generate cross-impl fixture (temp/charrss_anchors.json)" \
    python3 tools/_dump_anchors.py 200

run_step "[5/10] JS differential test" \
    node tools/charrss_difftest.mjs 3000

run_step "[6/10] Python <=> C++ brute force validation" \
    python3 tools/validate_cpp_oracle.py 1000

run_step "[7/10] Targetprey candidate scoring" \
    node tools/test_scoring.mjs 200

run_step "[8/10] Pull-transition tracker" \
    node tools/test_pull_probe.mjs

run_step "[9/10] m-protocol data collector" \
    node tools/test_datacollect.mjs

run_step "[10/10] Live-capture performance policy" \
    node tools/test_capture_perf.mjs

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
