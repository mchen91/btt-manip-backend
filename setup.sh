#!/usr/bin/env bash
#
# OPTIONAL: builds the C++ brute-force oracle (rng.cpp) used only to cross-validate the
# client-side CVP seed reconstruction (tools/validate_cpp_oracle.py). The static site
# itself needs none of this -- just serve docs/ (see run.sh). The pure-Python and JS
# validations (tools/validate_charrss.py, charrss_difftest.mjs) also need no setup.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
FORCE=false
REBUILD=false

for arg in "$@"; do
    case "$arg" in
        --force)   FORCE=true ;;
        --rebuild) REBUILD=true ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

cd "$SCRIPT_DIR"

# ── Helpers ────────────────────────────────────────────────────────────────────
ok()   { echo "[ok]  $*"; }
info() { echo "[..] $*"; }
fail() { echo "[!!] $*" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────────────
command -v python3 &>/dev/null || fail "python3 not found — install Python 3 and try again"
command -v c++    &>/dev/null || fail "c++ not found — install build-essential (sudo apt install build-essential)"

# ── Virtual environment ────────────────────────────────────────────────────────
if [[ -d "$VENV_DIR" && "$FORCE" == true ]]; then
    info "Removing existing venv (--force)"
    rm -rf "$VENV_DIR"
fi

if [[ ! -d "$VENV_DIR" ]]; then
    info "Creating virtual environment at $VENV_DIR"
    python3 -m venv "$VENV_DIR"
    ok "Virtual environment created"
else
    ok "Virtual environment already exists — skipping (use --force to recreate)"
fi

# ── Dependencies ───────────────────────────────────────────────────────────────
PYTHON="$VENV_DIR/bin/python3"

info "Installing/updating dependencies from requirements-dev.txt"
# Bootstrap pip via ensurepip in case the venv was created without it (common on Debian/Ubuntu)
"$PYTHON" -m ensurepip --upgrade 2>/dev/null || true
"$PYTHON" -m pip install --upgrade pip --quiet
"$PYTHON" -m pip install -r requirements-dev.txt --quiet
ok "Dependencies installed"

# ── C++ compilation ────────────────────────────────────────────────────────────
# Resolve the output filename using sysconfig (python3-config is not available inside a venv)
EXT_SUFFIX=$("$PYTHON" -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")
SO_FILE="rng${EXT_SUFFIX}"

needs_compile() {
    [[ ! -f "$SO_FILE" ]] && return 0
    [[ "rng.cpp" -nt "$SO_FILE" ]] && return 0
    return 1
}

if needs_compile || [[ "$REBUILD" == true ]]; then
    if [[ "$REBUILD" == true && -f "$SO_FILE" ]]; then
        info "Forcing recompilation (--rebuild)"
    else
        info "Compiling rng.cpp → $SO_FILE"
    fi

    c++ -O3 -Wall -shared -std=c++11 -fPIC \
        $("$PYTHON" -m pybind11 --includes) \
        rng.cpp -o "$SO_FILE"

    [[ -f "$SO_FILE" ]] || fail "Compilation appeared to succeed but $SO_FILE was not created"
    ok "Compiled $SO_FILE"
else
    ok "$SO_FILE is up to date — skipping recompilation (use --rebuild to force)"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "C++ oracle ready. Run the full validation suite (incl. the oracle cross-check) with:"
echo "  ./run_all_tests.sh"
echo ""
echo "To preview the static site locally, run:  ./run.sh"
