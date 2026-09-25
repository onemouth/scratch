# Agent Canvas

An in-memory infinite canvas for live Pi Coding Agents. Each node contains a real, interactive Pi terminal; a directed connection represents **delegated work**, not automatic message passing.

## Quick start

Requires Node.js 22+, npm and an authenticated `pi` on your PATH.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Choose an existing working directory by entering its absolute path, then either launch a **new Pi session** with an initial task or select **Resume · pi -r** to pick an existing session inside the terminal. New Pi sessions are saved by Pi so they can be resumed later; Canvas nodes themselves are not restored after server restart. Click inside the terminal to interact with Pi; Stop ends its process but leaves the node and its output until the server stops.

Use the bottom-right toggle: **Mouse** uses right-drag to pan and the wheel to zoom; **Touchpad** uses two-finger scroll to pan and pinch to zoom. Drag nodes by their headers, resize selected nodes, and connect right-to-left handles to record delegation.

## Documentation

- [Architecture](docs/architecture.md) — processes, canvas state, PTY streaming, lifecycle and boundaries.
- [Agent API Guide](docs/agent-api.md) — copyable instructions for agents; also available in the browser via **API Guide** or `GET /api/docs`. The web version fills in the correct browser-facing localhost URL.
- [Development](docs/development.md) — installation, ports, tests and source map.

For a single-server production-style run: `npm run build && npm start`, then open http://127.0.0.1:3001. Nothing is persisted after server restart; do not expose this unauthenticated local service to a network.
