#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/docs"
PORT="${1:-8000}"

fail() { echo "[!!] $*" >&2; exit 1; }

[[ -d "$DOCS_DIR" ]] || fail "docs/ not found next to run.sh"

# The site is pure static files; serve docs/ for local preview.
# Visit http://localhost:$PORT/  (this is exactly what GitHub Pages serves from /docs).
echo "Serving static site at http://localhost:$PORT/  (Ctrl-C to stop)"
exec python3 -m http.server "$PORT" --directory "$DOCS_DIR"
