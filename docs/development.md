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

Agent launch regression: with isolated storage and fake PTYs, delay SSE mutations while keeping the initial stream connected. New/Resume and the fixed Card box agent must appear and focus from their successful POST responses without reload, duplicate spawns or task replay. Launching into an empty workspace must preserve zoom. A delayed POST response must not overwrite a newer SSE version of the agent.

For a manual end-to-end check: choose a saved Pi session folder from the workdir dropdown (or enter one manually), then create an Agent in the browser; confirm its empty Pi TUI appears, type a simple task into the terminal, check resizing and the consistent 12px terminal font, create an edge and edit its label, check the Guide's copied URL and that Stop leaves the node visible. Remove the stopped node and check that its edges disappear, then try **Resume · pi -r** in the same workdir and choose that saved Pi session. Sending a task invokes your configured model; the automated tests do not.

For persistence checks, set both `AGENT_CANVAS_STATE_FILE` and `AGENT_CANVAS_CARDS_FILE` to temporary paths. The CLI otherwise uses the shared default card database even with a custom Canvas path. Create nodes and notes, restart the server, and verify the same IDs/layout return and running nodes reopen conversations without a task. Stop one node before restarting and verify it stays stopped. Test a missing session/workdir, then Reset Canvas and restart again to confirm it stays empty. Never run reset tests against your working Canvas.

For isolated card library/view browser testing without changing the live Canvas:

```sh
npm run test:views:browser
# Interactive disposable preview (prints an ephemeral localhost URL; fake echo agent, not Pi):
CANVAS_PREVIEW=1 npm run test:views:browser
# Optional Chrome path on another platform:
CHROME_BIN=/path/to/chrome npm run test:views:browser
# Optional screenshot of fixture UI:
CANVAS_SCREENSHOT=/tmp/card-views.png npm run test:views:browser
```

This launches an ephemeral loopback API/Vite middleware server, temporary JSON/SQLite/media/cache/session directories, one fake PTY (never Pi/model calls), and an owned headless Chrome profile. It never opens live Canvas data or ports. The test-only proxy strips Origin because the ephemeral Vite port is not a production allowlisted origin; production origin enforcement is unchanged. The fixture closes its owned servers/browser and removes temporary data, including on SIGINT/SIGTERM. Preview mode skips Chrome automation, keeps only its isolated API/Vite/fake PTY running until Ctrl+C, and never invokes a model. Do not restart a working Canvas just to test the branch; new backend endpoints/schema migration take effect on a later deliberate normal startup.

Test card creation, content/metadata editing and flipping, debounced auto-save, over-limit draft preservation and save blocking, Markdown rendering, reload retention, placement removal without library deletion, permanent deletion confirmation, and Reset preserving the library. Card box is a separate editable whiteboard, showing current-view cards and one shared fixed agent in a collapsible right sidebar. Check sidebar hide/show, browser-local visibility persistence, launch/notification focus reopening it, maximize/return, remaining-canvas fit geometry and unchanged PTY/WebSocket/DOM across hiding and workspace/view changes. Check mode switching preserves terminal DOM/connection, Canvas launches Pi with regular TUI mode, saved layout independence, append-only grid placement, singleton launch, stop/resume, exact-session restore and Agent Canvas reset isolation. Also test OR content/tag/ID search, pagination, responsive previews, named temporary/saved views, the fixed dynamic Unfiled view and retained layout, exact-tag and recursive-link metadata exploration, confirmation choices, universal new-card current-view membership, independent layouts/viewports, rename/deletion, reload/restart recovery and cross-tab selection/stale-dialog protection. Schema-1/2/3 Canvas JSON migrates to 4. SQLite schema 5 preserves legacy Markdown cards and adds Interactive Cards. Test API-only source authoring, title/tag/link editing, Library title-only previews, Play/Restart/error/reset lifecycle, locally bundled JSXGraph SVG/point/function/slider execution after Play and responsive maximize without iframe remount, responsive SVG/Canvas, sandbox CSP/network isolation, local-media symlink/path/signature/size limits, blob asset resolution and private-file deletion; old code cannot read the upgraded schemas. Never run migration tests on live data.

Media checks: use isolated data. Test real file drops in both modes, image+audio ordering, confirmation/cancel for replacements, image preview, audio seek and mode continuity, one-player behavior, independent invalid text drafts, stale replacement/removal conflicts, range responses and metadata persistence after restart. Accepted files must remain after replacement, unlinking, card deletion and reset. Invalid/aborted uploads must leave no staging files or changed associations. Test schema-3→4 migration without changing existing cards/links/sequences; older code rejects the new database schema. Backups need the entire images/ and audios/ directories as well as JSON/SQLite.

Agent Canvas layout regression: verify explicit creation geometry and partial updates for agents/notes/Markdown/interactive cards, cross-kind conflicts and edge contact, negative positions, rejection without partial card/view/PTy creation or metadata edits, and unchanged no-geometry defaults. Check all three native drag/resize controls start/renew leases, block ordinary API writes while active, persist the final human write before release, and expire abandoned/multi-tab leases. Existing-object API moves and explicitly API-positioned launches must not pan/zoom or steal focus; Card Box geometry stays independent. `scripts/tests/canvas-layout-browser.mjs` runs within the isolated views fixture. Never use live Canvas data for these tests.

Agent query checks: use isolated fake PTYs. Verify metadata-only state/list/single-agent queries and bounded ANSI output reads (including stopped agents), full card source on demand, unchanged SSE/WS replay and output persistence. The removed HTTP wait route must return 404 for existing/missing agents without modifying the target. There is no HTTP-only server mode. server/agent-queries.test.js includes an actual curl removal regression. Preserve flat HTTP errors; use notification tests for event delivery, fast transitions and generation handling.

Shared-memory prototype: `npm run test:shm` compiles the required POSIX addon and requires its tests to run. `npm run test:shm:pi` uses the installed Pi CLI in an isolated temporary directory, confirms production tool registration and invokes its reader implementation without an LLM call or HTTP. Test writers/readers/corruption helpers own unique shm names only. Never inspect/delete unknown shared-memory objects or use live agents for cleanup tests. See [shared-memory setup](shared-memory.md). npm dev/start/test lifecycle hooks always build the addon; obsolete opt-out settings cannot disable SHM or select HTTP-only mode. Native cases are explicitly skipped if unbuilt, and test:shm always requires compilation. Do not run a rebuild concurrently with native readers/tests. No runtime fallback pretends memory is shared.

SHM peer messaging: test independent SPSC role claims, atomic/incomplete publication, wraparound, queue-full rejection, invalid lengths/headers, reserved receipt credits, blocked outboxes versus delivery acks, two-way Unicode, stale/closed generations, source inference, bounded history, lost semaphore hints, expiry/uncertain handoffs, explicit wake policies and finite budgets. npm run test:shm:pi additionally launches two isolated real Pi processes, invokes production messaging tools, observes/forwards actual Pi API handoffs and verifies delivered receipts with HTTP forbidden and no LLM runs. It also checks real reload/new/resume/fork, queues messages during the detached-context gap, verifies current-context handoffs, independent telemetry session/activity/progress, monotonic process sequences and retained receipts, and removes its owned fixture sessions. Native helper objects are fixture-owned; never mutate live agents or scan for orphan names. See [messaging](agent-messaging.md).

## Source map

- `native/canvas-shm/` — owned Node-API POSIX snapshot/semaphore/SPSC queue bindings and upstream MIT notice.
- `server/canvas-notify.js`, `server/canvas-notify.test.js` — session subscriptions, ordered delivery, gap detection and independent-process notification tests.
- `server/canvas-memory.js`, `shared/canvas-memory.js` — projection publication, protocol validation and bounded pages.
- `server/canvas-messages.js`, `server/canvas-message-client.js`, `server/canvas-messages.test.js` — bounded peer routing, client receipts, lifecycle/generation isolation and independent-process tests.
- `shared/canvas-telemetry.js`, `server/canvas-telemetry.js`, `server/canvas-telemetry-client.js`, `server/pi-telemetry-process.js` — separate process-scoped Pi → Scratch reports/receipts transport and context rebinding; `server/pi-session-tracker.js` reports automatic session/activity and offers own-progress tool. See [telemetry](agent-telemetry.md).
- `server/pi-canvas-messages.js`, `server/pi-message-process.js` — SHM send/status tools and a process-scoped broker that rebinds current Pi contexts across session changes/reload without losing queues or receipts.
- `server/pi-canvas-memory.js` — optional read-only Pi tool, no auto-context or message delivery.
- `scripts/build-shm.js`, `scripts/tests/*shm*` — local build and isolated native/real-Pi fixtures.

- `server/index.js` — composition root, Canvas state, auto-save/restore, publication and shutdown orchestration.
- `server/canvas-operations.js` — domain validation/mutations for cards, notes, views, layout, agents, delegation and messages.
- `server/agent-runtime.js` — Pi process lifecycle, run/session/activity state, bounded output and metadata queries.
- `server/http-routes.js` — HTTP parsing/origin/errors, media/static responses, SSE.
- `server/terminal-transport.js` — unchanged browser terminal WS replay/input/resize.
- `server/session-workdirs.js` — bounded saved-session header scanning.
- `server/agent-queries.test.js` — metadata/output/activity HTTP integration and removed-wait curl regression.
- `server/validation.js` — shared text validation helper.
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
- `server/card-views.js`, `server/card-views.test.js` — view lifecycle, atomic temporary transitions, independent layouts, old-save migration and persistence.
- `shared/card-search.js`, `shared/card-search.test.js` — Unicode-normalized OR library search.
- `src/card-views.jsx`, `scripts/tests/card-views-browser.mjs` — sidebar/view dialogs and isolated browser verification.
- `server/card-box-layout.js`, `server/card-box.test.js` — append-only grid placement and fixed-agent/layout lifecycle tests.
- `src/main.jsx` — canvas and terminal browser UI.
- `src/agent-state.js`, `src/agent-state.test.js` — immediate successful launch inclusion without relying on SSE, duplicate prevention and preservation of newer streamed state.
- `src/style.css` — canvas, nodes, terminal and guide styling.
- `docs/agent-api.md` — single source for the copyable agent-facing API guide (the server substitutes `$AGENT_CANVAS_URL` when serving it).
- `docs/architecture.md` — runtime data flow and boundaries.

## Current scope

Card box supports named shared views, not multiple Agent Canvases or separate per-user views. No authentication/per-user isolation, automatic agent-to-agent message forwarding or workflow scheduler. Explicit peer messages use SHM outboxes/mailboxes and Pi custom-message handoffs. POST /api/messages and session/activity HTTP callbacks are removed (404); Agent note PATCH is rejected atomically (400). SHM API handoff does not prove the recipient processed the text. The single Canvas is auto-saved to a local JSON file; cards live in a separate SQLite library, while their placements are saved with the Canvas. Pi sessions are saved by Pi; Canvas restore reopens the exact conversation when available, falling back to `pi -r` without replaying interrupted work. Agents may describe and change Agent Canvas layout through the documented collision/gesture-checked API; Card Box geometry/viewports remain human-only. No general authentication or human-gesture-marker enforcement against malicious callers is provided. See [architecture](architecture.md) and [agent API guide](agent-api.md) for details.
