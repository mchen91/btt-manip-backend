#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/docs"
PORT="${1:-8000}"

fail() { echo "[!!] $*" >&2; exit 1; }

[[ -d "$DOCS_DIR" ]] || fail "docs/ not found next to run.sh"

# The site is pure static files; serve docs/ for local preview.
# Visit http://localhost:$PORT/  (this is exactly what GitHub Pages serves from /docs).
# Cache-Control: no-cache makes the browser revalidate every file, so a git
# pull never leaves the page running a mix of old and new JS modules.
echo "Serving static site at http://localhost:$PORT/  (Ctrl-C to stop)"
exec python3 - "$PORT" "$DOCS_DIR" <<'PY'
import http.server, sys

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

port, directory = int(sys.argv[1]), sys.argv[2]
handler = lambda *a, **kw: NoCacheHandler(*a, directory=directory, **kw)
http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
PY
