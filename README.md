# Agent Canvas

An auto-saved infinite canvas for live Pi Coding Agents. Each node contains a real, interactive Pi terminal; a directed connection represents **delegated work**, not automatic message passing. Agents can explicitly send messages to a running Pi node via the local API.

## Quick start

Requires Node.js 22+, npm and an authenticated `pi` on your PATH.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Enter an existing working directory's absolute path, or choose one from the saved Pi session folders dropdown, then either launch a **new Pi session** and type directly in its terminal, or select **Resume · pi -r** to pick an existing session inside the terminal. Canvas nodes and Pi conversations can be restored after server restart (see below). Newly created agents (New or Resume) are brought into view, selected, and focused so you can type immediately; reopening a stopped node also focuses its terminal. Initial page load and reconnect do not steal focus. Click inside any terminal to switch to it; Stop ends its process but leaves the node and its output. A stopped node has a Remove button to delete it and its connections from this canvas (not Pi's saved session).

Use the bottom-right toggle: **Mouse** uses right-drag to pan and the wheel to zoom; **Touchpad** uses two-finger scroll to pan and pinch to zoom. Drag nodes by their headers, resize selected nodes, and connect right-to-left handles to record delegation. Click a connection's label to edit its display text; the underlying relationship remains a delegation.

Use **＋ Note** to add a yellow sticky note. Click its title to rename it (Enter/blur saves, Escape cancels; blank resets to Note). Drag the header's empty area, resize it when selected, and edit its text directly (saved when the editor loses focus). Click **×** to delete it. Notes are independent of agents and are saved with the Canvas.

## Auto-save, restore and reset

One Canvas is auto-saved to `~/.agent-canvas/canvas.json` (override with `AGENT_CANVAS_STATE_FILE`). Metadata changes are saved after 250 ms of inactivity with atomic replacement and a `.bak` previous-save backup. Normal shutdown flushes immediately. The file contains node metadata, notes, edges, layout, session identities and recent terminal output; treat it as private. Unsubmitted terminal input, active tools, browser viewport and pointer mode are not saved.

On restart, previously running nodes automatically reopen their exact Pi conversation with **no prompt sent**. Missing or invalid sessions fall back to `pi -r`; a nonzero process exit before Pi reports a loaded session also falls back once. Missing workdirs leave a stopped node with an error. Previously stopped nodes stay stopped; use **▶** to reopen their conversation. User-installed Pi extensions still run normally on startup.

**Reset Canvas** asks for confirmation, stops all Pi processes, clears nodes/notes/edges, and saves an empty Canvas. It does **not** delete Pi sessions or project files. Save failures appear in the browser. Corrupt/unsupported save files prevent server startup instead of being overwritten; inspect the original and `.bak` before manually recovering. A process lock prevents multiple servers from opening the same save file; stale locks from exited processes are recovered automatically.

## Documentation

- [Architecture](docs/architecture.md) — processes, canvas state, PTY streaming, lifecycle and boundaries.
- [Agent API Guide](docs/agent-api.md) — copyable instructions for agents; also available in the browser via **API Guide** or `GET /api/docs`. The web version fills in the correct browser-facing localhost URL.
- [Development](docs/development.md) — installation, ports, tests and source map.

For a single-server production-style run: `npm run build && npm start`, then open http://127.0.0.1:3001. Do not expose this unauthenticated local service to a network.
