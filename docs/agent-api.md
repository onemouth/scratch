# Agent Canvas — Agent API Guide

You can use the Agent Canvas API to observe the shared canvas, create Pi agents, send explicit messages to running agents, and record **real delegation relationships**. Run these HTTP commands with your shell/bash tool. This server is local to the user's machine; do not expose it to the network.

## Locate the server and your identity

- This web guide substitutes the **current running API URL** into every command below, so you can copy it into an agent as-is. The server listens on the same machine at `127.0.0.1`; pasted commands will not work on a different machine.
- Canvas-launched agents also have `AGENT_CANVAS_URL` and `AGENT_CANVAS_ID` (their own node ID) in their environment.
- If this guide was pasted into a different agent, tell it whether it has a Canvas node, and provide that node's ID if so. **Do not assume an external agent already has a node**: agents not launched by the Canvas do not have `AGENT_CANVAS_ID`.
- Canvas-launched agents can also fetch this guide: `curl -fsS "$AGENT_CANVAS_URL/api/docs"`.
- The API accepts JSON. Replace `<...>` placeholders in the examples. Only use an existing directory for `workdir`.

## Read the canvas

```sh
curl -fsS "$AGENT_CANVAS_URL/api/state"
```

Returns `{ "agents": [...], "edges": [...] }`. Agents have `id`, `name`, `workdir`, `task`, `status` (`running` or `stopped`), `note`, recent raw terminal `output`, and layout fields. Edges have `id`, `source`, `target`, `type: "delegates"`, and a human-editable `label` (default `"delegates"`). Raw output contains terminal escape codes. Node IDs can be found here; don't guess them.

## Delegate work to a new Pi agent

```sh
curl -fsS -X POST "$AGENT_CANVAS_URL/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Researcher","workdir":"/absolute/path/to/project","task":"Investigate the parser and report findings","parentId":"<YOUR_AGENT_ID>"}'
```

Required: `name` (max 100 chars) and `workdir` (existing directory; use an absolute path). For a new session, `task` is optional: when omitted, Pi opens interactively with an empty editor; when supplied, it runs as the initial instruction. When delegating work, supply a specific task so the worker knows what to do. Optional: `parentId`, the ID of the delegating agent. Supplying `parentId` **automatically creates a directed `delegates` edge** from parent to child. The response contains the new agent's ID. Omit `parentId` to create an independent agent. Each agent has its own Pi process; both can work in the same directory, so coordinate edits to avoid conflicts. New Pi sessions are saved by Pi, but the Canvas layout is not persisted.

When launched by the Canvas, substitute your ID by constructing the JSON safely (for example with `jq`):

```sh
jq -n --arg name 'Researcher' --arg dir "$PWD" --arg task 'Investigate the parser' --arg parent "$AGENT_CANVAS_ID" \
  '{name:$name,workdir:$dir,task:$task,parentId:$parent}' |
  curl -fsS -X POST "$AGENT_CANVAS_URL/api/agents" -H 'Content-Type: application/json' --data-binary @-
```

## Open Pi's saved-session picker (optional)

If you want to continue a session previously saved by Pi in this workdir, create a node with `"mode":"resume"` **instead of** an initial task. This runs `pi -r` in that node's terminal, where a human selects the session; it does not automatically choose one. Do not use this for an unattended delegated task that needs to start immediately.

```sh
curl -fsS -X POST "$AGENT_CANVAS_URL/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Previous work","workdir":"/absolute/path/to/project","mode":"resume"}'
```

`mode` defaults to `"new"`; for `"resume"`, omit `task`. The new Canvas node has its own ID even though its Pi session is resumed. You can include `parentId` only when this is an actual delegation.

## Message an existing Pi agent

Use an agent **ID** from `GET /api/state` to address a running node. Include `fromId` when sending from a Canvas agent so the receiver can tell who sent it:

```sh
jq -n --arg to '<TARGET_AGENT_ID>' --arg from "$AGENT_CANVAS_ID" --arg text 'Hi, please review the test results' \
  '{toId:$to,fromId:$from,text:$text}' |
  curl -fsS -X POST "$AGENT_CANVAS_URL/api/messages" -H 'Content-Type: application/json' --data-binary @-
```

Alternatively, use `{"toName":"Researcher","text":"Hi"}` instead of `toId` **only if the name is unique** (exact match). Specify exactly one of `toId` or `toName`; duplicate names return HTTP 409, missing agents return 404, and stopped agents return 409. `fromId` is optional (for a human or external client) but must be an existing agent ID if supplied. The `text` must be non-blank, at most 10,000 characters, and contain no terminal control characters; ordinary newlines are allowed.

The API returns HTTP 202 once the text has been written to the destination's Pi TTY using bracketed paste followed by Enter. **This is not a delivery/read acknowledgement**: it does not guarantee Pi has processed the message. As with typing into the terminal, avoid sending while the recipient is in a picker, editing an unfinished prompt, or running another terminal application. Sending a message does **not** create a delegation edge. Edges never forward messages automatically.

## Record or remove a delegation

Use this only if one agent has genuinely delegated work to another **existing** agent. This records a relationship; it does **not** send a message or task to the target.

```sh
curl -fsS -X POST "$AGENT_CANVAS_URL/api/edges" \
  -H 'Content-Type: application/json' \
  -d '{"source":"<DELEGATING_AGENT_ID>","target":"<WORKER_AGENT_ID>"}'
```

You may include an optional `"label":"Investigates parser"` (1–120 characters) when creating an edge. A label describes the work; **the relationship type remains `delegates`**. Duplicate directed edges return the existing edge; self-delegation is rejected.

To rename an existing edge:

```sh
curl -fsS -X PATCH "$AGENT_CANVAS_URL/api/edges/<EDGE_ID>" \
  -H 'Content-Type: application/json' -d '{"label":"Investigates parser"}'
```

To remove an edge: `curl -fsS -X DELETE "$AGENT_CANVAS_URL/api/edges/<EDGE_ID>"`.

## Update your progress note

```sh
curl -fsS -X PATCH "$AGENT_CANVAS_URL/api/agents/$AGENT_CANVAS_ID" \
  -H 'Content-Type: application/json' \
  -d '{"note":"Reviewing tests; waiting for researcher findings"}'
```

Notes are at most 500 characters and appear on the node. Only update **your own** note. Layout fields (`x`, `y`, `width`, `height`) are for the human UI; agents should not change coordinates or rendering.

## Other interfaces and boundaries

- `GET /api/session-workdirs` lists existing workdirs referenced by saved Pi session headers (used by the web UI's workdir dropdown; it does not read conversation content).
- `GET /api/events` is a Server-Sent Events stream of canvas snapshots (used by the web UI).
- `WS /api/terminal/:id` streams PTY output and accepts raw terminal input and resize messages (used by the web UI). Prefer `POST /api/messages` for explicit agent-to-agent messages.
- `POST /api/agents/:id/stop` terminates a Pi process. `DELETE /api/agents/:id` removes a **stopped** node and its relationships from this canvas, but does not delete its saved Pi session. Don't stop or remove another agent unless explicitly asked.
- Calls return JSON; failures return `{ "error": "..." }` with a non-2xx HTTP status. `curl -f` treats these as errors.
- There is **no automatic message passing**, no authentication, and no persistence after server restart. Use the API only against the local server and record relationships only for actual work.
