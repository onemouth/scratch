# Architecture

Agent Canvas is one local Node.js server and a React browser client. The server owns the in-memory canvas and the Pi processes; the browser draws the canvas and acts as a terminal emulator. Nothing is stored across server restarts.

```text
Human browser ── React Flow canvas ─── HTTP /api/* ─┐
              ├─ state updates (SSE /api/events) ─────┤ Node server
              └─ terminal I/O (WS /api/terminal/:id) ─┤   ├─ in-memory agents + edges
                                                       └───┴─ node-pty → pi TUI (one per agent)
Pi agents ───────── curl to localhost /api/* ──────────┘
```

## Ownership and data flow

- `server/index.js` owns agents, directed edges, active PTYs, terminal socket subscribers and SSE clients. An agent record contains its ID, workdir, task, status, note, layout and a capped raw terminal-output tail. The server broadcasts state snapshots when metadata changes; terminal bytes go over WebSocket independently.
- `src/main.jsx` uses React Flow for pan, zoom, nodes, resize and connections. Layout changes are sent back to the server with `PATCH /api/agents/:id`. Mouse mode uses right-drag for pan and wheel for zoom; touchpad mode uses scroll for pan and pinch for zoom. These are browser interaction choices, not Agent API concepts.
- An agent runs `pi` in interactive mode inside a `node-pty` process. **New** mode starts in the requested workdir, optionally with an initial task supplied through the API; the human UI launches it without a task so the user can type in the terminal. Pi saves its session normally. **Resume** mode runs `pi -r` there, opening Pi's own saved-session picker in the terminal without an initial task. Both receive a short appended system prompt explaining the semantic API and `AGENT_CANVAS_URL` / `AGENT_CANVAS_ID` environment variables. Child agents spawned via the API receive the same integration.
- `@xterm/xterm` renders PTY output and sends keystrokes to `/api/terminal/:id`; `@xterm/addon-fit` reports terminal column/row changes. Connecting to an existing node replays the server's recent raw output before subscribing to live output.
- `docs/agent-api.md` is the source for the in-app **API Guide**. `GET /api/docs` serves it as Markdown and replaces the URL in examples with the backend address or, when the browser requests it, its local Vite proxy origin. The guide can be copied into another agent.

## Relationships and lifecycle

An edge `source → target` means the source **delegated work** to the target. Creating a child with `parentId` adds that edge; `POST /api/edges` can record delegation between existing agents. An edge is not a message channel and does not orchestrate execution.

An agent is `running` while its Pi process exists and `stopped` after exit or Stop. A finished Pi task leaves the interactive process available for follow-up prompts. Stopping a process keeps the node, its last output and all relationships until the server exits or a human removes it. Only a fully stopped node can be removed; removal deletes its in-memory node, terminal replay and incident edges, but never Pi's saved session files. Pi saves sessions independently, which can later be chosen via Resume; the server itself does not restore canvas nodes, relationships or terminals after restart.

## Boundaries

This is **localhost-only**: the HTTP server binds to `127.0.0.1` and rejects foreign browser origins; it has no authentication or isolation from other local processes. An agent with shell access can call the API, so the guide asks it to modify only its own note and to record relationships only for real delegation. This is guidance, not an authorization boundary. Do not expose the server to a network.

Terminal replay is limited to the last 80,000 raw characters per node; truncating an ANSI stream may make the replay after refresh visually incomplete. Browser xterm.js may not support all native terminal features (for example Kitty keyboard protocol, images or external-editor integration). Node resizing and the semantic API are intentionally separate.
