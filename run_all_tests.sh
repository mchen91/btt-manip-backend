#!/usr/bin/env bash
# Run all CharRSS validation tools in the correct order.
#
# Usage:
#   ./run_all_tests.sh [RSS_COUNT]
#
#   RSS_COUNT  random seeds for the Python RSS validation (default 5000)
#
# Requires: Python 3 with fractions, Node (ESM support).
# Step 4 (C++ oracle) requires the compiled rng.so; it is skipped gracefully if absent.

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

run_step "[1/6] Python RSS validation" \
    python3 tools/validate_charrss.py "$RSS_COUNT"

run_step "[2/6] Generate cross-impl fixture (temp/charrss_anchors.json)" \
    python3 tools/_dump_anchors.py 200

run_step "[3/6] JS differential test" \
    node tools/charrss_difftest.mjs 3000

run_step "[4/6] Python <=> C++ brute force validation" \
    python3 tools/validate_cpp_oracle.py 1000

run_step "[5/6] Targetprey candidate scoring" \
    node tools/test_scoring.mjs 200

run_step "[6/6] m-protocol data collector" \
    node tools/test_datacollect.mjs

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
