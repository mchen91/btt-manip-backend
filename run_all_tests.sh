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

run_step "[1/4] Python RSS validation" \
    python3 tools/validate_charrss.py "$RSS_COUNT"

run_step "[2/4] Generate cross-impl fixture (temp/charrss_anchors.json)" \
    python3 tools/_dump_anchors.py 200

run_step "[3/4] JS differential test" \
    node tools/charrss_difftest.mjs 3000

run_step "[4/4] Python <=> C++ brute force validation" \
    python3 tools/validate_cpp_oracle.py 1000

echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
