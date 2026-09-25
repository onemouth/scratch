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

## Source map

- `server/index.js` — in-memory state, validation, Pi PTYs, HTTP/SSE/WebSocket, static production assets, served API guide.
- `server/index.test.js` — API lifecycle, saved-session workdirs, delegation, terminal I/O and guide URL tests using a fake PTY.
- `src/main.jsx` — canvas and terminal browser UI.
- `src/style.css` — canvas, nodes, terminal and guide styling.
- `docs/agent-api.md` — single source for the copyable agent-facing API guide (the server substitutes `$AGENT_CANVAS_URL` when serving it).
- `docs/architecture.md` — runtime data flow and boundaries.

## Current scope

No database, canvas restart recovery, multi-user access, agent-to-agent message forwarding or workflow scheduler. Pi sessions are saved by Pi and can be picked again with `pi -r`, but Canvas nodes and relationships are not persisted. Keep UI coordinates out of instructions to agents: agents describe work and delegation, while the browser controls spatial layout. See [architecture](architecture.md) and [agent API guide](agent-api.md) for details.
