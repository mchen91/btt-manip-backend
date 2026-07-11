#!/usr/bin/env python3
"""Static site server for docs/ plus a tiny action-stream relay.

Serving docs/ is unchanged from the old inline run.sh server (no-cache static
files). The relay lets the manip page push its rendered action list to any
viewer on the LAN:

  POST /api/actions          body: JSON {"text": str, "ts": int} -- store + fan out
  GET  /api/actions/stream   Server-Sent Events; replays latest payload on connect
  GET  /api/actions/latest   JSON of last payload (204 if none yet)

A second channel flows the other way, viewer -> manip page (e.g. the viewer's
Reset button when a manip goes wrong and the seed must be re-found):

  POST /api/control          body: JSON {"cmd": str} -- fan out to manip page
  GET  /api/control/stream   SSE; no replay (a stale command must never re-fire
                             when the manip page reloads)

State is in-memory only; a restart just means the viewer waits for the next
Search. SSE picked over WebSocket so the whole thing stays stdlib-only.
"""
import http.server
import json
import queue
import sys
import threading
import time

MAX_BODY = 64 * 1024

CONTROL_COMMANDS = {'reset'}

_lock = threading.Lock()
_subscribers = {'actions': [], 'control': []}  # channel -> list[queue.Queue]
_latest = None  # last actions payload (bytes), replayed to new viewers


def _publish(channel, payload_bytes):
    global _latest
    with _lock:
        if channel == 'actions':
            _latest = payload_bytes
        subs = list(_subscribers[channel])
    for q in subs:
        q.put(payload_bytes)


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_POST(self):
        if self.path == '/api/actions':
            self._post_actions()
        elif self.path == '/api/control':
            self._post_control()
        else:
            self.send_error(404)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0 or length > MAX_BODY:
            self.send_error(413 if length > MAX_BODY else 400)
            return None
        return json.loads(self.rfile.read(length))

    def _post_actions(self):
        try:
            data = self._read_json_body()
            if data is None:
                return
            text = data['text']
            if not isinstance(text, str):
                raise ValueError('text must be a string')
            # Optional manip-target info (e.g. post-bomb seed for the viewer's
            # sword-seed list). Opaque to the relay beyond a shape check.
            target = data.get('target')
            if target is not None and not isinstance(target, dict):
                raise ValueError('target must be an object')
        except (ValueError, KeyError) as e:
            self.send_error(400, str(e))
            return
        payload = json.dumps({
            'text': text,
            'target': target,
            'ts': data.get('ts', int(time.time() * 1000)),
        }).encode()
        _publish('actions', payload)
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _post_control(self):
        try:
            data = self._read_json_body()
            if data is None:
                return
            cmd = data['cmd']
            if cmd not in CONTROL_COMMANDS:
                raise ValueError(f'unknown cmd: {cmd!r}')
        except (ValueError, KeyError) as e:
            self.send_error(400, str(e))
            return
        _publish('control', json.dumps({'cmd': cmd, 'ts': int(time.time() * 1000)}).encode())
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path == '/api/actions/stream':
            self._serve_stream('actions')
        elif self.path == '/api/control/stream':
            self._serve_stream('control')
        elif self.path == '/api/actions/latest':
            self._serve_latest()
        else:
            super().do_GET()

    def _serve_latest(self):
        with _lock:
            payload = _latest
        if payload is None:
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _serve_stream(self, channel):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()

        q = queue.Queue()
        with _lock:
            _subscribers[channel].append(q)
            payload = _latest if channel == 'actions' else None
        try:
            if payload is not None:
                self._send_event(payload)
            while True:
                try:
                    payload = q.get(timeout=15)
                    self._send_event(payload)
                except queue.Empty:
                    # Keepalive comment; also surfaces dead connections.
                    self.wfile.write(b': keepalive\n\n')
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with _lock:
                _subscribers[channel].remove(q)

    def _send_event(self, payload):
        self.wfile.write(b'data: ' + payload + b'\n\n')
        self.wfile.flush()

    def log_message(self, fmt, *args):
        # Keep the console quiet for stream keepalives; log everything else.
        if '/stream' not in str(args[0] if args else ''):
            super().log_message(fmt, *args)


def main():
    port, directory = int(sys.argv[1]), sys.argv[2]
    handler = lambda *a, **kw: Handler(*a, directory=directory, **kw)
    server = http.server.ThreadingHTTPServer(('', port), handler)
    server.daemon_threads = True
    print(f'Serving static site + action stream at http://localhost:{port}/  (Ctrl-C to stop)')
    print(f'Viewer page for other machines: http://<this-machine-ip>:{port}/viewer.html')
    server.serve_forever()


if __name__ == '__main__':
    main()
