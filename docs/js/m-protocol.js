"use strict";

// Vendored from https://github.com/gainge/m-protocol (web/m-protocol.js).
// Do not edit here — update by re-copying from upstream.
//
// m-protocol — a tiny browser client for the m-protocol daemon.
//
// Drop-in: <script src="m-protocol.js"></script>. No bundler, no exports.
// Exposes MProtocol on window.
//
// Owns the WebSocket lifecycle, the path → value cache, the /lookups.json
// fetch, snapshot/detach reset semantics, and auto-reconnect. Surfaces
// lifecycle frames as events ("welcome", "attach", "detach", "snapshot",
// "delta", "lagged", "error") plus two connection-state events ("connecting",
// "reconnect"), and per-path subscriptions via onPath().
//
// Connection robustness (so a consumer never gets pinned on "connecting…"):
//
//   - Connect watchdog. new WebSocket() always succeeds and enters CONNECTING
//     even when nothing is listening; a wedged SYN can sit there indefinitely.
//     We force-close and retry any socket that hasn't reached "open" within
//     connectTimeoutMs (default 5s). This is what stops a refused/half-open
//     daemon from leaving the UI stuck — including across a hard refresh, which
//     otherwise just starts a fresh doomed CONNECTING socket.
//   - Exponential backoff. Retries grow from reconnectDelayMs up to
//     maxReconnectDelayMs, reset to 0 on a successful open.
//   - Wake on visibility/online. Background tabs get their reconnect timer
//     throttled; we retry immediately when the tab is foregrounded or the
//     network returns (disable with wakeOnVisible: false).
//   - Staleness heartbeat (OPT-IN, default off). If staleTimeoutMs is set, a
//     connection that goes silent that long is treated as dead and reconnected.
//     Off by default because a healthy daemon legitimately emits nothing when
//     no deltas are flowing (Dolphin not attached, or a paused/static game),
//     and a passive "no data = dead" check would false-positive there. Only
//     enable it for consumers that subscribe to a continuously-changing path.
//
// The "connecting" event fires at the start of each socket attempt; "reconnect"
// fires when a retry is scheduled (payload { attempt, delayMs, cause }). Together
// they let a consumer distinguish "negotiating" from "daemon down, backing off"
// — a distinction the bare "connecting…" label cannot make on its own.
//
// Malformed subscribe patterns (e.g. an unsupported mid-string wildcard) are
// reported by the daemon in the welcome frame; the client exposes them on
// client.subscriptionWarnings and console.warns each so the misuse is visible
// without any handler wiring.
//
// Two value-state distinctions external authors must understand:
//
//   undefined — the path has not been observed yet. Either it isn't covered
//               by the current subscription, or the daemon hasn't read it
//               yet, or no Dolphin is attached.
//   null      — the daemon HAS read this path, but its owning pointer is
//               currently invalid (e.g. between matches, on the CSS, entity
//               GObj torn down). Only pointer-chased paths (player.N.entity.*,
//               slippi.*) can emit null. The path may resume emitting typed
//               values once the pointer becomes valid again.
//
// client.get(path) returns the cached value (may be null). client.has(path)
// returns true if the path has ever been observed (including null).

(function (global) {
  const PROTOCOL_VERSION = "1";
  const DEFAULT_WS_URL = "ws://127.0.0.1:43501/ws";
  const DEFAULT_LOOKUPS_URL = "http://127.0.0.1:43501/lookups.json";
  const DEFAULT_RECONNECT_DELAY_MS = 1500;
  const DEFAULT_MAX_RECONNECT_DELAY_MS = 5000;
  const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

  const LIFECYCLE_EVENTS = new Set([
    "welcome",
    "attach",
    "detach",
    "snapshot",
    "delta",
    "lagged",
    "error",
    "connecting",
    "reconnect",
  ]);

  // Compiled subscription pattern. Same grammar as internal/proto/filter.go:
  // "*" or "" → match all; "prefix.*" → prefix match (including the dot);
  // anything else → exact match.
  function compilePattern(p) {
    if (p === "" || p === "*") return { kind: "all" };
    if (p.endsWith(".*")) return { kind: "prefix", prefix: p.slice(0, -1) };
    return { kind: "exact", path: p };
  }

  function patternMatches(pat, path) {
    switch (pat.kind) {
      case "all":
        return true;
      case "prefix":
        return path.startsWith(pat.prefix);
      case "exact":
        return path === pat.path;
    }
    return false;
  }

  class MProtocol {
    constructor(opts) {
      opts = opts || {};
      this.url = opts.url || DEFAULT_WS_URL;
      this.lookupsUrl = opts.lookupsUrl === undefined ? DEFAULT_LOOKUPS_URL : opts.lookupsUrl;
      this.subscribe = (opts.subscribe && opts.subscribe.slice()) || ["*"];
      this.protocol = opts.protocol || PROTOCOL_VERSION;
      this.reconnectDelayMs =
        opts.reconnect === null
          ? null
          : opts.reconnect && typeof opts.reconnect.delayMs === "number"
            ? opts.reconnect.delayMs
            : DEFAULT_RECONNECT_DELAY_MS;
      this.maxReconnectDelayMs =
        opts.reconnect && typeof opts.reconnect.maxDelayMs === "number"
          ? opts.reconnect.maxDelayMs
          : DEFAULT_MAX_RECONNECT_DELAY_MS;
      // Watchdog for the CONNECTING phase. null disables (the socket is then
      // allowed to sit in CONNECTING until the browser/OS gives up).
      this.connectTimeoutMs =
        opts.connectTimeoutMs === null
          ? null
          : typeof opts.connectTimeoutMs === "number"
            ? opts.connectTimeoutMs
            : DEFAULT_CONNECT_TIMEOUT_MS;
      // Opt-in staleness heartbeat — see header comment for why it's off by
      // default. A number enables it; anything else leaves it disabled.
      this.staleTimeoutMs = typeof opts.staleTimeoutMs === "number" ? opts.staleTimeoutMs : null;
      this.wakeOnVisible = opts.wakeOnVisible === undefined ? true : !!opts.wakeOnVisible;

      // Public read-only-ish state. Mutated by the library; external code
      // should read but not write.
      this.connected = false;
      this.attached = false;
      this.meta = { game: null, mapVersion: null, lookupsVersion: null };
      this.process = null; // {name, pid} after attach
      this.stats = { snapshots: 0, deltas: 0, lagged: 0 };
      this.lookups = null;

      // Daemon-reported notices about subscribe patterns that compiled to
      // something unintended (e.g. an unsupported mid-string wildcard like
      // "slippi.player.*.name"). Populated from the welcome frame; empty when
      // every pattern is well-formed. Also auto-logged via console.warn so the
      // misuse surfaces even if no one wires up an on("welcome") handler.
      this.subscriptionWarnings = [];

      // Path cache. Includes null entries for pointer-invalidated paths.
      this._values = Object.create(null);

      // Listeners keyed by event name, plus path listeners as a flat list.
      this._listeners = Object.create(null);
      this._pathListeners = []; // [{pattern, cb}]

      this._ws = null;
      this._reconnectTimer = null;
      this._connectTimer = null;
      this._staleTimer = null;
      this._lastMessageAt = 0;
      this._reconnectAttempts = 0;
      this._userClosed = false;
      this._wakeInstalled = false;
      // Bound once so add/removeEventListener pair up. Installed on connect(),
      // removed on close().
      this._wakeHandler = () => this._onWake();
    }

    // ---- event registration ----------------------------------------------

    on(event, cb) {
      if (!LIFECYCLE_EVENTS.has(event)) {
        throw new Error(`MProtocol.on: unknown event "${event}"`);
      }
      (this._listeners[event] || (this._listeners[event] = [])).push(cb);
      return this;
    }

    off(event, cb) {
      const list = this._listeners[event];
      if (!list) return this;
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
      return this;
    }

    // Subscribe to value changes on a specific path or pattern. Same grammar
    // as the daemon's subscribe filter. The callback receives the NEW value,
    // the PREVIOUS value (undefined on first observation), and the full path.
    // Note this is a client-side filter — the daemon still streams whatever
    // the WS-level subscribe asks for. Use onPath() to fan out within an
    // already-subscribed namespace.
    onPath(pattern, cb) {
      this._pathListeners.push({ pattern: compilePattern(pattern), cb });
      return this;
    }

    // ---- cache access ----------------------------------------------------

    get(path) {
      return this._values[path];
    }

    has(path) {
      return path in this._values;
    }

    // Returns a shallow copy of the current cache (path → value). Includes
    // null entries.
    snapshot() {
      return Object.assign(Object.create(null), this._values);
    }

    // ---- connection control ----------------------------------------------

    async connect() {
      this._userClosed = false;
      // Idempotent: a socket already in flight or open means a session is live;
      // don't stack a second one (which would orphan the first and double every
      // subsequent reconnect chain).
      if (this._ws) return this;
      this._installWakeHandlers();
      // Lookups fetch is best-effort — we await it before opening the WS so
      // client.lookups is populated by the time "welcome" fires. Failure
      // (daemon not up yet, sidecar disabled with -lookups -, CORS in a
      // hosted-page context) is non-fatal; client.lookups stays null and is
      // retried on each later welcome until it succeeds (see _handleMessage).
      await this._fetchLookups();
      this._openSocket();
      return this;
    }

    // Best-effort one-shot lookups fetch. Resolves whether or not it populated
    // this.lookups; callers never need to catch.
    async _fetchLookups() {
      if (!this.lookupsUrl || this.lookups !== null) return;
      try {
        const res = await fetch(this.lookupsUrl, { cache: "no-cache" });
        if (res.ok) this.lookups = await res.json();
      } catch (_) {
        /* keep this.lookups = null; a later welcome retries */
      }
    }

    // Close the socket and stop auto-reconnect. After close(), call connect()
    // to start a new session.
    close() {
      this._userClosed = true;
      this._removeWakeHandlers();
      this._clearTimers();
      if (this._ws) {
        try {
          this._ws.close();
        } catch (_) {}
      }
    }

    _clearTimers() {
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._clearConnectTimer();
      this._clearStaleTimer();
    }

    _clearConnectTimer() {
      if (this._connectTimer !== null) {
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
    }

    _clearStaleTimer() {
      if (this._staleTimer !== null) {
        clearInterval(this._staleTimer);
        this._staleTimer = null;
      }
    }

    // Replace the WS-level subscribe set. Until the daemon supports an in-band
    // re-subscribe message, this closes and reopens the WS — values seen
    // before the reconnect remain cached on the new connection's snapshot.
    updateSubscribe(patterns) {
      this.subscribe = patterns.slice();
      if (this._ws) {
        try {
          this._ws.close();
        } catch (_) {}
      }
    }

    // ---- internals -------------------------------------------------------

    _openSocket() {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        this._scheduleReconnect("construct");
        this._emit("error", { code: 0, reason: String(e && e.message), cause: "construct" });
        return;
      }
      this._ws = ws;
      this._emit("connecting", { url: this.url, attempt: this._reconnectAttempts });

      // Connect watchdog: a socket that never reaches "open" is force-closed so
      // the close handler can retry, rather than letting the UI sit on
      // "connecting…" until the browser/OS eventually gives up (or never does).
      if (this.connectTimeoutMs !== null) {
        this._connectTimer = setTimeout(() => {
          this._connectTimer = null;
          if (ws.readyState === WebSocket.CONNECTING) {
            // close() fires the "close" listener below → _scheduleReconnect.
            try {
              ws.close();
            } catch (_) {}
          }
        }, this.connectTimeoutMs);
      }

      ws.addEventListener("open", () => {
        this._clearConnectTimer();
        this._reconnectAttempts = 0;
        this.connected = true;
        this._lastMessageAt = Date.now();
        this._startStaleTimer();
        ws.send(
          JSON.stringify({
            type: "hello",
            protocol: this.protocol,
            subscribe: this.subscribe,
          })
        );
      });

      ws.addEventListener("message", (e) => {
        this._lastMessageAt = Date.now();
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch (_) {
          return;
        }
        this._handleMessage(msg);
      });

      ws.addEventListener("close", (e) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.attached = false;
        this.process = null;
        this._clearConnectTimer();
        this._clearStaleTimer();
        if (this._ws === ws) this._ws = null;
        // Surface non-1000 closes (and protocol-rejection 1008 in particular)
        // as a synthetic error so consumers don't have to listen to raw close.
        if (wasConnected && e.code !== 1000 && e.code !== 1005) {
          this._emit("error", { code: e.code, reason: e.reason || "", cause: "close" });
        }
        this._scheduleReconnect("close");
      });

      ws.addEventListener("error", () => {
        // The 'error' DOM event carries no useful detail; we rely on 'close'
        // for the actual code/reason. Don't double-emit.
      });
    }

    _startStaleTimer() {
      this._clearStaleTimer();
      if (this.staleTimeoutMs === null) return;
      // Poll at a fraction of the timeout so detection latency stays bounded.
      const period = Math.max(1000, Math.floor(this.staleTimeoutMs / 2));
      this._staleTimer = setInterval(() => {
        if (!this.connected) return;
        if (Date.now() - this._lastMessageAt < this.staleTimeoutMs) return;
        // Silent too long → assume the connection is dead. Force-close; the
        // close handler reconnects. Drop the stale timer first so it can't
        // re-fire against the dying socket.
        this._clearStaleTimer();
        if (this._ws) {
          try {
            this._ws.close();
          } catch (_) {}
        }
      }, period);
    }

    _scheduleReconnect(cause) {
      if (this._userClosed || this.reconnectDelayMs === null) return;
      if (this._reconnectTimer !== null) return;
      const delayMs = Math.min(
        this.reconnectDelayMs * Math.pow(2, this._reconnectAttempts),
        this.maxReconnectDelayMs
      );
      this._reconnectAttempts++;
      this._emit("reconnect", {
        attempt: this._reconnectAttempts,
        delayMs,
        cause: cause || "close",
      });
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._openSocket();
      }, delayMs);
    }

    // Retry immediately when the tab is foregrounded or the network returns —
    // background tabs throttle the reconnect timer, so a long idle can leave us
    // waiting far longer than the backoff intended. No-op while a socket is
    // already in flight/open or the user has closed the client.
    _onWake() {
      if (this._userClosed || this._ws || this.reconnectDelayMs === null) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._reconnectAttempts = 0;
      this._openSocket();
    }

    _installWakeHandlers() {
      if (!this.wakeOnVisible || this._wakeInstalled) return;
      this._wakeInstalled = true;
      if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("visibilitychange", this._wakeHandler);
      }
      if (typeof window !== "undefined" && window.addEventListener) {
        window.addEventListener("online", this._wakeHandler);
      }
    }

    _removeWakeHandlers() {
      if (!this._wakeInstalled) return;
      this._wakeInstalled = false;
      if (typeof document !== "undefined" && document.removeEventListener) {
        document.removeEventListener("visibilitychange", this._wakeHandler);
      }
      if (typeof window !== "undefined" && window.removeEventListener) {
        window.removeEventListener("online", this._wakeHandler);
      }
    }

    _handleMessage(msg) {
      switch (msg.type) {
        case "welcome":
          this.meta.game = msg.game || null;
          this.meta.mapVersion = msg.mapVersion || null;
          this.meta.lookupsVersion = msg.lookupsVersion || null;
          this.subscriptionWarnings = msg.subscriptionWarnings || [];
          for (const w of this.subscriptionWarnings) {
            console.warn("MProtocol subscribe warning:", w);
          }
          // If the daemon came up after the page (initial fetch failed) the
          // lookups are still null — retry now that we know it's reachable.
          // Fire-and-forget; consumers read client.lookups lazily.
          if (this.lookups === null) this._fetchLookups();
          this._emit("welcome", msg);
          return;

        case "attach":
          this.attached = true;
          this.process = { name: msg.process || null, pid: msg.pid || null };
          this._emit("attach", msg);
          return;

        case "detach":
          this.attached = false;
          this.process = null;
          // Drop the cache: a detach means the next attach is a new session
          // and stale paths from the previous one would be misleading. The
          // daemon will re-emit a snapshot on next attach anyway.
          this._resetCacheAndNotify();
          this._emit("detach", msg);
          return;

        case "snapshot":
          // Snapshot is authoritative for the subscribed namespace. Clear
          // first so paths from a previous session/subscription don't linger.
          this._resetCacheAndNotify();
          this._mergeValues(msg.values || {});
          this.stats.snapshots++;
          this._emit("snapshot", msg);
          return;

        case "delta":
          this._mergeValues(msg.values || {});
          this.stats.deltas++;
          this._emit("delta", msg);
          return;

        case "lagged":
          this.stats.lagged += msg.dropped || 0;
          this._emit("lagged", msg);
          return;
      }
      // Unknown message types are ignored — additive protocol changes (new
      // type constants) must remain non-breaking for existing consumers.
    }

    _mergeValues(values) {
      for (const path in values) {
        const next = values[path];
        const prev = this._values[path];
        this._values[path] = next; // store nulls verbatim
        if (prev === next) continue;
        this._firePathListeners(path, next, prev);
      }
    }

    // Drop all cached paths and notify path listeners that anything they were
    // watching has gone undefined. Used on snapshot (about to be repopulated)
    // and on detach.
    _resetCacheAndNotify() {
      const old = this._values;
      this._values = Object.create(null);
      for (const path in old) {
        this._firePathListeners(path, undefined, old[path]);
      }
    }

    _firePathListeners(path, next, prev) {
      for (const { pattern, cb } of this._pathListeners) {
        if (patternMatches(pattern, path)) {
          try {
            cb(next, prev, path);
          } catch (e) {
            // Don't let a single broken listener kill the message pump.
            // Consumers can listen to console.error in dev.
            console.error("MProtocol onPath listener threw:", e);
          }
        }
      }
    }

    _emit(event, payload) {
      const list = this._listeners[event];
      if (!list) return;
      for (const cb of list) {
        try {
          cb(payload);
        } catch (e) {
          console.error(`MProtocol on("${event}") listener threw:`, e);
        }
      }
    }
  }

  global.MProtocol = MProtocol;
})(typeof window !== "undefined" ? window : globalThis);
