# Agent Canvas

An in-memory infinite canvas for live Pi Coding Agents. Each node contains a real, interactive Pi terminal; a directed connection represents **delegated work**, not automatic message passing. Agents can explicitly send messages to a running Pi node via the local API.

## Quick start

Requires Node.js 22+, npm and an authenticated `pi` on your PATH.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Enter an existing working directory's absolute path, or choose one from the saved Pi session folders dropdown, then either launch a **new Pi session** and type directly in its terminal, or select **Resume · pi -r** to pick an existing session inside the terminal. New Pi sessions are saved by Pi so they can be resumed later; Canvas nodes themselves are not restored after server restart. Click inside the terminal to interact with Pi; Stop ends its process but leaves the node and its output. A stopped node has a Remove button to delete it and its connections from this canvas (not Pi's saved session).

Use the bottom-right toggle: **Mouse** uses right-drag to pan and the wheel to zoom; **Touchpad** uses two-finger scroll to pan and pinch to zoom. Drag nodes by their headers, resize selected nodes, and connect right-to-left handles to record delegation. Click a connection's label to edit its display text; the underlying relationship remains a delegation.

Use **＋ Note** to add a yellow sticky note. Click its title to rename it (Enter/blur saves, Escape cancels; blank resets to Note). Drag the header's empty area, resize it when selected, and edit its text directly (saved when the editor loses focus). Click **×** to delete it. Notes are independent of agents and disappear when the server restarts.

## Documentation

- [Architecture](docs/architecture.md) — processes, canvas state, PTY streaming, lifecycle and boundaries.
- [Agent API Guide](docs/agent-api.md) — copyable instructions for agents; also available in the browser via **API Guide** or `GET /api/docs`. The web version fills in the correct browser-facing localhost URL.
- [Development](docs/development.md) — installation, ports, tests and source map.

For a single-server production-style run: `npm run build && npm start`, then open http://127.0.0.1:3001. Nothing is persisted after server restart; do not expose this unauthenticated local service to a network.
