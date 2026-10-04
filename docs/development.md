# Development

## Prerequisites

- Node.js 22.13+ and npm (built-in SQLite; Node 22 may emit an experimental warning)
- `pi` on your `PATH`, with a model/provider configured and authenticated
- A compiler toolchain if `node-pty` cannot use a prebuilt binary. On macOS the project's `postinstall` script fixes the executable permission on node-pty's `spawn-helper` when needed.

## Run and verify

```sh
npm install
npm run dev       # browser: http://127.0.0.1:5173 ; API: http://127.0.0.1:3001
npm test          # API and PTY bridge tests (mock Pi process; no model calls)
npm run build
npm start         # serves built app and API together on http://127.0.0.1:3001
```

Vite proxies `/api` (including the terminal WebSocket) to the Node server in development. If you change the API port, set `PORT` for `npm run dev`; both backend and Vite's proxy target read it. Vite uses fixed strict port 5173. Avoid running `npm start` and `npm run dev` simultaneously on port 3001.

For optional private tailnet **dev-mode** access (Serve → Vite 5173 → /api backend), see [README](../README.md#private-tailscale-access-optional). `npm run tailscale:setup` only inspects and prints a plan; `--apply` mutates Serve and must be run explicitly by the user after checking access policies. Do not apply/reset a real Tailscale configuration during automated tests. Unit tests use injected CLI responses and fake PTYs to cover fail-closed setup, HTTP/WS origin enforcement, guide URLs and loopback agent URLs. For an HTTPS proxy smoke test, use isolated state/cards, a loopback test proxy and fake PTYs; verify HMR without page reload, local and remote Vite access, SSE, WSS input/output and attachment requests without invoking real models or modifying live data.

For a manual end-to-end check: choose a saved Pi session folder from the workdir dropdown (or enter one manually), then create an Agent in the browser; confirm its empty Pi TUI appears, type a simple task into the terminal, check resizing, create an edge and edit its label, check the Guide's copied URL and that Stop leaves the node visible. Remove the stopped node and check that its edges disappear, then try **Resume · pi -r** in the same workdir and choose that saved Pi session. Sending a task invokes your configured model; the automated tests do not.

For persistence checks, set both `AGENT_CANVAS_STATE_FILE` and `AGENT_CANVAS_CARDS_FILE` to temporary paths. The CLI otherwise uses the shared default card database even with a custom Canvas path. Create nodes and notes, restart the server, and verify the same IDs/layout return and running nodes reopen conversations without a task. Stop one node before restarting and verify it stays stopped. Test a missing session/workdir, then Reset Canvas and restart again to confirm it stays empty. Never run reset tests against your working Canvas.

For isolated card-box testing without changing the live Canvas:

```sh
npm run build
TEST_DIR=$(mktemp -d)
PORT=3002 AGENT_CANVAS_STATE_FILE="$TEST_DIR/canvas.json" \
  AGENT_CANVAS_CARDS_FILE="$TEST_DIR/cards.sqlite" npm start
# Open http://127.0.0.1:3002
```

Test card creation, content/metadata editing and flipping, debounced auto-save, over-limit draft preservation and save blocking, Markdown rendering, reload retention, placement removal without library deletion, permanent deletion confirmation, and Reset preserving the library. Card box is a separate editable whiteboard, showing all library cards and at most one fixed agent. Check mode switching preserves terminal DOM/connection, saved layout independence, append-only grid placement, singleton launch, stop/resume, exact-session restore and Agent Canvas reset isolation. No query/filter or selected-card interaction is included. Version-2 Canvas files are not readable by the pre-card-box branch.

Media checks: use isolated data. Test real file drops in both modes, image+audio ordering, confirmation/cancel for replacements, image preview, audio seek and mode continuity, one-player behavior, independent invalid text drafts, stale replacement/removal conflicts, range responses and metadata persistence after restart. Accepted files must remain after replacement, unlinking, card deletion and reset. Invalid/aborted uploads must leave no staging files or changed associations. Test schema-3→4 migration without changing existing cards/links/sequences; older code rejects the new database schema. Backups need the entire images/ and audios/ directories as well as JSON/SQLite.

## Source map

- `server/index.js` — live state, auto-save/restore orchestration, validation, Pi PTYs, HTTP/SSE/WebSocket, static production assets, served API guide.
- `vite.config.js`, `server/dev-config.test.js` — strict loopback dev port, exact trusted Vite hostname and API/WS proxy configuration.
- `server/public-origin.js`, `server/public-origin.test.js` — exact opt-in HTTPS origin validation and HTTP/WebSocket policy tests.
- `scripts/tailscale-setup.js`, `scripts/tailscale-setup.test.js` — read-only planning, explicit Serve setup and existing-configuration safeguards.
- `server/storage-paths.js` — Documents data defaults and stopped-server legacy migration.
- `server/canvas-store.js` — snapshot validation, atomic save and previous-save backup.
- `server/pi-session-tracker.js` — Pi lifecycle extension reporting exact conversation identity and turn activity.
- `skills/agent-canvas/SKILL.md` — explicitly loaded for each Canvas-launched Pi; directs API work to the running server's full guide.
- `server/persistence.test.js` — isolated save/restart, fallback, reset and corruption tests.
- `server/index.test.js` — API lifecycle, saved-session workdirs, delegation, explicit TTY messaging, terminal I/O and guide URL tests using a fake PTY.
- `server/card-store.js` — SQLite cards, schema version, daily sequences, startup backup.
- `server/card-links.test.js`, `server/card-links-migration.test.js` — reciprocal additions/removals, timestamps, atomic rollback on full targets, v2 backfill and historical references.
- `server/cards.test.js`, `server/card-store.test.js` — isolated card API, persistence and backup tests.
- `server/card-media-store.js`, `server/card-media.test.js` — validated streaming uploads, retained files, HTTP range serving and migration tests.
- `shared/card-media.js`, `shared/card-media.test.js` — supported kinds, limits and drop validation.
- `src/card-media.jsx`, `src/card-audio.js`, `src/card-audio.test.js` — attachment UI and shared playback state.
- `shared/card-content.js` — shared Markdown validation and 400-unit counter.
- `src/cards.jsx` — front/back editable cards shared by both workspace modes.
- `server/card-box-layout.js`, `server/card-box.test.js` — append-only grid placement and fixed-agent/layout lifecycle tests.
- `src/main.jsx` — canvas and terminal browser UI.
- `src/style.css` — canvas, nodes, terminal and guide styling.
- `docs/agent-api.md` — single source for the copyable agent-facing API guide (the server substitutes `$AGENT_CANVAS_URL` when serving it).
- `docs/architecture.md` — runtime data flow and boundaries.

## Current scope

No multiple named canvases, multi-user access, automatic agent-to-agent message forwarding or workflow scheduler. Explicit messages to existing running nodes use `POST /api/messages` and write to their TTYs; a successful response does not prove the recipient processed the text. The single Canvas is auto-saved to a local JSON file; cards live in a separate SQLite library, while their placements are saved with the Canvas. Pi sessions are saved by Pi; Canvas restore reopens the exact conversation when available, falling back to `pi -r` without replaying interrupted work. Keep UI coordinates out of instructions to agents: agents describe work and delegation, while the browser controls spatial layout. See [architecture](architecture.md) and [agent API guide](agent-api.md) for details.
