# Development

## Prerequisites

- Node.js 22+ and npm
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

Vite proxies `/api` (including the terminal WebSocket) to the Node server in development. If you change the API port, update both `PORT` for the server and the proxy target in `vite.config.js`. Avoid running `npm start` and `npm run dev` simultaneously on port 3001.

For a manual end-to-end check: choose a saved Pi session folder from the workdir dropdown (or enter one manually), then create an Agent in the browser; confirm its empty Pi TUI appears, type a simple task into the terminal, check resizing, create an edge and edit its label, check the Guide's copied URL and that Stop leaves the node visible. Remove the stopped node and check that its edges disappear, then try **Resume · pi -r** in the same workdir and choose that saved Pi session. Sending a task invokes your configured model; the automated tests do not.

For persistence checks, set `AGENT_CANVAS_STATE_FILE` to a temporary path. Create nodes and notes, restart the server, and verify the same IDs/layout return and running nodes reopen conversations without a task. Stop one node before restarting and verify it stays stopped. Test a missing session/workdir, then Reset Canvas and restart again to confirm it stays empty. Never run reset tests against your working Canvas.

## Source map

- `server/index.js` — live state, auto-save/restore orchestration, validation, Pi PTYs, HTTP/SSE/WebSocket, static production assets, served API guide.
- `server/canvas-store.js` — snapshot validation, atomic save and previous-save backup.
- `server/pi-session-tracker.js` — Pi lifecycle extension reporting exact conversation identity.
- `server/persistence.test.js` — isolated save/restart, fallback, reset and corruption tests.
- `server/index.test.js` — API lifecycle, saved-session workdirs, delegation, explicit TTY messaging, terminal I/O and guide URL tests using a fake PTY.
- `src/main.jsx` — canvas and terminal browser UI.
- `src/style.css` — canvas, nodes, terminal and guide styling.
- `docs/agent-api.md` — single source for the copyable agent-facing API guide (the server substitutes `$AGENT_CANVAS_URL` when serving it).
- `docs/architecture.md` — runtime data flow and boundaries.

## Current scope

No database, multiple named canvases, multi-user access, automatic agent-to-agent message forwarding or workflow scheduler. Explicit messages to existing running nodes use `POST /api/messages` and write to their TTYs; a successful response does not prove the recipient processed the text. The single Canvas is auto-saved to a local JSON file. Pi sessions are saved by Pi; Canvas restore reopens the exact conversation when available, falling back to `pi -r` without replaying interrupted work. Keep UI coordinates out of instructions to agents: agents describe work and delegation, while the browser controls spatial layout. See [architecture](architecture.md) and [agent API guide](agent-api.md) for details.
