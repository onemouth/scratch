# Architecture

Agent Canvas is one local Node.js server and a React browser client. The server owns the in-memory canvas and the Pi processes; the browser draws the canvas and acts as a terminal emulator. A single Canvas is auto-saved on disk and restored on restart; Pi conversations remain in Pi's own session files.

```text
Human browser ── React Flow canvas ─── HTTP /api/* ─┐
              ├─ state updates (SSE /api/events) ─────┤ Node server
              └─ terminal I/O (WS /api/terminal/:id) ─┤   ├─ in-memory agents + edges
                                                       └───┴─ node-pty → pi TUI (one per agent)
Pi agents ───────── curl to localhost /api/* ──────────┘
```

## Ownership and data flow

- `server/index.js` owns agents, directed edges, active PTYs, terminal socket subscribers and SSE clients. An agent record contains its ID, workdir, task, status, note, layout and a capped raw terminal-output tail. The server broadcasts state snapshots when metadata changes; terminal bytes go over WebSocket independently.
- `src/main.jsx` uses React Flow for pan, zoom, nodes, resize and connections. Layout changes are sent back to the server with `PATCH /api/agents/:id`. Mouse mode uses right-drag for pan and wheel for zoom; touchpad mode uses scroll for pan and pinch for zoom. The workdir dropdown reads only the `cwd` header of saved Pi session JSONL files via `GET /api/session-workdirs`; users can still type any valid directory. These are browser interaction choices, not Agent API concepts.
- An agent runs `pi` in interactive mode inside a `node-pty` process. **New** mode starts in the requested workdir, optionally with an initial task supplied through the API; the human UI launches it without a task so the user can type in the terminal. Pi saves its session normally. **Resume** mode runs `pi -r` there, opening Pi's own saved-session picker in the terminal without an initial task. Both receive a short appended system prompt explaining the semantic API and `AGENT_CANVAS_URL` / `AGENT_CANVAS_ID` environment variables. Child agents spawned via the API receive the same integration.
- `@xterm/xterm` renders PTY output and sends keystrokes to `/api/terminal/:id`; `@xterm/addon-fit` reports terminal column/row changes. Connecting to an existing node replays the server's recent raw output before subscribing to live output.
- `docs/agent-api.md` is the source for the in-app **API Guide**. `GET /api/docs` serves it as Markdown and replaces the URL in examples with the backend address or, when the browser requests it, its local Vite proxy origin. The guide can be copied into another agent.

## Relationships and lifecycle

An edge `source → target` means the source **delegated work** to the target. Creating a child with `parentId` adds that edge; `POST /api/edges` can record delegation between existing agents. The edge's display `label` is editable via `PATCH /api/edges/:id`, while its `type` remains `delegates`. An edge is not a message channel and does not orchestrate execution. Explicit `POST /api/messages` calls can target a running agent by ID or unique name; the server writes bracketed-paste text followed by Enter to that agent's PTY. A 202 response means written to the PTY, not confirmed as processed by Pi. Messaging never creates edges.

An agent is `running` while its Pi process exists and `stopped` after exit or Stop. A finished Pi task leaves the interactive process available for follow-up prompts. Stopping a process keeps the node, its last output and all relationships until a human removes it or resets the Canvas. Only a fully stopped node can be removed; removal deletes its in-memory node, terminal replay and incident edges, but never Pi's saved session files. Pi saves sessions independently. The server restores Canvas nodes and relationships and reopens previously running agents' conversations, without replaying their initial task or any terminal input.

## Persistence and session identity

`server/canvas-store.js` validates versioned snapshots and writes them through a flushed temporary file followed by atomic rename; the previous valid save becomes `.bak`. Metadata updates debounce for 250 ms. Graceful shutdown flushes running/stopped intent before terminating processes, so shutdown exits do not overwrite the restore decision. Output is captured in the next metadata save or shutdown flush, not on every streamed byte. Invalid saves fail startup without being overwritten. Save errors are exposed in state and the UI. The default CLI file is `~/.agent-canvas/canvas.json`; `AGENT_CANVAS_STATE_FILE` overrides it. Test instances use `stateFile: null` unless explicitly testing persistence.

`server/pi-session-tracker.js` is passed via Pi's explicit `--extension` option. Its `session_start` hook reports the exact session file and ID on initial startup, resume, new session, fork, and reload. A per-process run token rejects stale callbacks after reset or restart; it is not a general authentication boundary. The extension never sends messages or starts turns. The API binds before Pi launches, so the callback has a live destination.

Restore validates the saved session file and identity, then launches `pi --session <path>` with no task arguments. Missing/invalid sessions use `pi -r`. A nonzero exit before the tracker reports readiness falls back to the picker once; later failures do not cause automatic relaunch loops. Missing workdirs retain a stopped node with a warning. Previously stopped nodes remain stopped and can be explicitly resumed in place. Third-party Pi extensions still run normally and may have their own startup behavior.

Reset requires confirmation, stops all processes (with a bounded SIGKILL escalation), closes terminal sockets, clears state and immediately writes the empty Canvas. Saved Pi sessions and project files are untouched. A PID-based exclusive lock prevents multiple servers from using the same save file; a lock left by a dead process is reclaimed at startup. Browser viewport, pointer mode and unsubmitted editor input are not persisted.

## Boundaries

This is **localhost-only**: the HTTP server binds to `127.0.0.1` and rejects foreign browser origins; it has no authentication or isolation from other local processes. An agent with shell access can call the API, so the guide asks it to modify only its own note and to record relationships only for real delegation. This is guidance, not an authorization boundary. Do not expose the server to a network.

Terminal replay is limited to the last 80,000 raw characters per node; truncating an ANSI stream may make the replay after refresh visually incomplete. Browser xterm.js may not support all native terminal features (for example Kitty keyboard protocol, images or external-editor integration). Node resizing and the semantic API are intentionally separate.
