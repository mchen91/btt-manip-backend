#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

fail() { echo "[!!] $*" >&2; exit 1; }

cd "$SCRIPT_DIR"

# ── Guard rails ────────────────────────────────────────────────────────────────
[[ -d "$VENV_DIR" ]] || fail "Virtual environment not found. Run ./setup.sh first."

SO_FILE=$(find . -maxdepth 1 -name 'rng*.so' 2>/dev/null | head -1)
[[ -n "$SO_FILE" ]] || fail "Compiled rng module not found. Run ./setup.sh first."

# ── Launch ─────────────────────────────────────────────────────────────────────
exec "$VENV_DIR/bin/python3" app.py
