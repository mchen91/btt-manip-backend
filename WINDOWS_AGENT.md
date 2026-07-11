# Windows-machine agent: m-protocol live validation

You are picking up work started on another machine. Read
[`PLAN_MPROTOCOL.md`](PLAN_MPROTOCOL.md) first for full context. Short
version: this repo's webapp (in `docs/`) now has a **passive run-data
collector** (`docs/js/datacollect.js`) that consumes the
[m-protocol](https://github.com/gainge/m-protocol) daemon to measure how many
RNG rolls each Peach BTT run consumes between the manip'd bomb pull and the
sword-slot pull. All code is written and tested against a synthetic daemon
feed (`tools/test_datacollect.mjs`); what's left is validating against the
real daemon + Dolphin on this machine, because the dev machine was a Mac and
the daemon is Windows-only.

**Rule boundary (do not "improve" past it):** the daemon may only ever feed
the statistics model used to plan *future* runs. It must never locate,
verify, or advance the seed used by the current run — that stays on the
camera + character-roll flow. This is a hard constraint from the user, not an
oversight.

## 1. Build and run the daemon

Prereqs: Go ≥ 1.18, git, and `make` with a POSIX shell (Git Bash works;
`choco install make` if needed). No C compiler required (CGO disabled).

```sh
git clone https://github.com/gainge/m-protocol
cd m-protocol
make gen        # required once per fresh checkout (generates embedded JSON)
make windows    # -> bin/m-protocold.exe
bin/m-protocold.exe
```

Alternatively the exe can be cross-compiled on any machine
(`CGO_ENABLED=0 GOOS=windows GOARCH=amd64`, after `make gen`) and copied over.

Start Dolphin (Slippi builds fine) with **Melee NTSC 1.02 (GALE01)**. The
daemon auto-discovers and attaches. Verify:

- `http://127.0.0.1:43501/paths.json` loads and includes `match.random_seed`.
- Open `m-protocol/web/test.html` from disk, subscribe to `match.random_seed`
  and `frame`, and confirm values stream during a match.

## 2. Serve the webapp

```sh
git clone <this repo> && cd <this repo>
git checkout video-capture
./run.sh            # serves docs/ at http://localhost:8000
```

(The GitHub Pages URL also works in current Chrome/Firefox — loopback
`ws://127.0.0.1` is exempt from mixed-content blocking — but if the panel
never leaves "connecting…" on the hosted page, fall back to localhost.)

## 3. Wire up and validate

In the webapp, expand **📈 Run Data — m-protocol (beta)**:

1. Check **Enable daemon connection**. Expect the status line to reach
   `daemon: attached to Dolphin`. Pick the controller **Port** Peach uses.
2. Full-loop validation (camera flow as usual, daemon just watching):
   - Locate the seed with 9 random character rolls, select **bomb** or
     **targetprey**, perform the manip, start the run.
   - At the first pull expect status: `pull 1 anchored (N rolls after
     target) — manip confirmed` with N ≈ 12–14.
   - After the third pull (the sword slot, ~2.97s in) expect:
     `recorded C=<value>, est. <item> …` with C roughly 1700–2100.
   - Compare `est. <item>` against what actually appeared on screen. The
     estimate comes from the seed sampled at the pull frame; mid-frame
     sampling can occasionally misclassify. Report the agreement rate over
     ~10 runs — if it's poor, the sampling-offset assumption needs work.
3. Collect ≥ 20 measured runs (practice endings are fine — measurement
   happens at the pull frame, nothing after it matters). The stats line
   flips to `model ACTIVE for targetprey`, and targetprey searches start
   using the measured mean/σ (shown above the candidate list).
4. **Export JSON** and sanity-check the distribution: mean near 1899 and σ
   near 36 would confirm the year-old spreadsheet; a materially different σ
   is important news either way (it directly scales the displayed
   success rates).

## 4. Known knobs if something misbehaves

All in `docs/js/datacollect.js`:

- `ANCHOR_MAX_ROLLS` (40): raise if pull 1 never anchors even though the
  manip visibly landed (status stays silent). Check the console for errors
  first.
- Pull transitions missed entirely: confirm action-state 352 (Peach's
  vegetable pull, hardcoded in `PULL_ACTION_STATE`) fires on every pull
  (watch `player.N.entity.action_state` in `web/test.html`), and check for
  `lagged` daemon messages (the ring buffer tolerates gaps, but a
  chronically lagging feed loses transition frames).
- `frame` vs seed pairing: the collector assumes both paths update in the
  same poll. If C values look quantized/offset by a consistent ~10–20 rolls,
  that's the documented mid-frame sampling bias — fine as long as it's
  consistent; report it.
- Headless test suite still passes on this machine: `./run_all_tests.sh`
  (steps 5 and 6 are the new ones; they need only Node).

## 5. Report back

Summarize: daemon build/attach experience, anchor rate, est.-outcome
agreement rate, number of measurements, measured mean/σ vs 1899/36, and
any constants you had to change (with the values).
