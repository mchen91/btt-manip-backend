#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/docs"
PORT="${1:-8000}"

fail() { echo "[!!] $*" >&2; exit 1; }

[[ -d "$DOCS_DIR" ]] || fail "docs/ not found next to run.sh"

# Static site (exactly what GitHub Pages serves from /docs) plus the
# action-stream relay endpoints -- see tools/serve.py.
# Cache-Control: no-cache makes the browser revalidate every file, so a git
# pull never leaves the page running a mix of old and new JS modules.
exec python3 "$SCRIPT_DIR/tools/serve.py" "$PORT" "$DOCS_DIR"
