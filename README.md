# Agent Canvas

An in-memory infinite canvas for live Pi Coding Agents. One node is one Pi RPC process; directed connections mean **delegates to** (they do not forward messages).

## Run

Requires Node.js 22+, npm, and `pi` on your PATH with a configured model/authentication.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. The API runs at http://127.0.0.1:3001. For a single-server build: `npm run build && npm start`, then open http://127.0.0.1:3001.

Choose an existing working directory and a first task when creating an agent. Pi runs in that directory. Type in its node for follow-up prompts (queued while busy); use Abort to interrupt the current run or Stop to end its process. A stopped node keeps its output and connections until the server exits. Nothing survives a server restart.

Drag to pan, scroll to zoom; drag a node by its header, click it to resize, connect the right handle to another node's left handle to record a delegation, click an edge to remove it.

## Local API

Agents receive `AGENT_CANVAS_URL` and `AGENT_CANVAS_ID` and a system prompt explaining these endpoints. Calls are JSON over HTTP; the API accepts requests only from localhost and rejects foreign browser origins. This is a local tool, not a multi-user or publicly exposed service.

- `GET /api/state` — agents (including status, notes and recent output), directed edges.
- `POST /api/agents` — `{ "name": "Worker", "workdir": "/absolute/path", "task": "Do X", "parentId": "optional-parent-id" }`. A `parentId` automatically records a delegation edge; no task messages are forwarded separately.
- `PATCH /api/agents/:id` — `{ "note": "Progress summary" }` (human UI also writes `x`, `y`, `width`, `height`).
- `POST /api/edges` — `{ "source": "parent-id", "target": "child-id" }`.
- `DELETE /api/edges/:id` — remove a relationship.
- `POST /api/agents/:id/prompt` — `{ "message": "..." }`.
- `POST /api/agents/:id/abort` and `POST /api/agents/:id/stop`.
- `GET /api/events` — live Server-Sent Events containing state snapshots.

For example, from inside an agent:

```sh
curl -s "$AGENT_CANVAS_URL/api/state"
curl -s -X PATCH "$AGENT_CANVAS_URL/api/agents/$AGENT_CANVAS_ID" -H 'Content-Type: application/json' -d '{"note":"Checking tests"}'
```

## Limitations

The node is a Pi conversation terminal (streamed text and tool output with prompt entry), **not a full PTY shell**. Pi extension dialogs are cancelled in this MVP. Recent output is capped at 80,000 characters per agent. Processes stay alive while idle to support follow-up prompts; Stop terminates them. No authentication, persistence, workflow engine, or remote access.

Run `npm test` for API tests.
