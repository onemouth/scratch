# Agent Canvas

An in-memory infinite canvas for live Pi Coding Agents. One node is one real Pi terminal (PTY); directed connections mean **delegates to** (they do not forward messages).

## Run

Requires Node.js 22+, npm, and `pi` on your PATH with a configured model/authentication. `node-pty` is a native dependency and may need a working compiler toolchain during install.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API runs at http://127.0.0.1:3001. For a single-server build: `npm run build && npm start`, then open http://127.0.0.1:3001.

Choose an existing working directory and a first task when creating an agent. Pi starts in interactive mode inside that directory with the first task supplied at launch. Click the terminal to type directly in the Pi TUI; Pi's built-in editor, menus, shortcuts, colors and output appear inside the node. Stop terminates the process. A stopped node keeps its last output and relationships until the server exits. Nothing survives a server restart.

Use the bottom-right pointer toggle: **Mouse** (default) uses right-button drag to pan and the wheel to zoom; **Touchpad** uses two-finger scroll to pan and pinch to zoom (you can also drag empty canvas space). Drag a node by its header, click it to resize, connect its right handle to another node's left handle to record delegation, click an edge to remove it. Scroll inside a terminal to scroll its output.

## API guide for agents

Click **API Guide** in the top bar to read and copy a complete Markdown guide into any agent. The served guide at [`/api/docs`](http://127.0.0.1:3001/api/docs) replaces URL variables in [`API.md`](API.md) with the address you use to open it: port 5173 via the development proxy, or port 3001 directly. Its commands can be pasted directly. A Canvas-launched agent already gets a short system-prompt introduction plus the docs URL; an external agent may still need its Canvas node ID from you.

## Local API

Agents receive `AGENT_CANVAS_URL` and `AGENT_CANVAS_ID` and a system prompt explaining the endpoints. Calls are JSON over HTTP; the server only binds to localhost and rejects foreign browser origins. This is a local tool, not a multi-user or publicly exposed service.

- `GET /api/docs` — the copyable Markdown API guide.
- `GET /api/state` — agents (including status, notes and recent raw terminal output), directed edges.
- `POST /api/agents` — `{ "name": "Worker", "workdir": "/absolute/path", "task": "Do X", "parentId": "optional-parent-id" }`. A `parentId` automatically records a delegation edge; no task messages are forwarded separately.
- `PATCH /api/agents/:id` — `{ "note": "Progress summary" }` (human UI also writes `x`, `y`, `width`, `height`).
- `POST /api/edges` — `{ "source": "parent-id", "target": "child-id" }`.
- `DELETE /api/edges/:id` — remove a relationship.
- `POST /api/agents/:id/stop` — terminate Pi.
- `GET /api/events` — live Server-Sent Events containing state snapshots.
- `WS /api/terminal/:id` — raw PTY output frames; send JSON `{ "type": "input", "data": "..." }` or `{ "type": "resize", "cols": 80, "rows": 24 }`.

For example, from inside an agent:

```sh
curl -s "$AGENT_CANVAS_URL/api/state"
curl -s -X PATCH "$AGENT_CANVAS_URL/api/agents/$AGENT_CANVAS_ID" -H 'Content-Type: application/json' -d '{"note":"Checking tests"}'
```

## Limitations

Pi uses the xterm.js terminal capabilities exposed by the browser; some terminal-specific features (notably Kitty keyboard protocol, terminal image/clipboard integration, or an external editor) may differ from a native shell. Recent raw output is capped at 80,000 characters per agent, so a long-running agent may replay only the tail on browser refresh; ongoing PTY output remains live. Sessions use `--no-session` and are not persisted. No authentication, workflow engine, or remote access.

Run `npm test` for API and PTY-bridge tests.
