# Delegate work to a new Pi agent

```sh
curl -fsS -X POST "$AGENT_CANVAS_URL/api/agents" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Researcher","workdir":"/absolute/path/to/project","task":"Investigate the parser and report findings","parentId":"<YOUR_AGENT_ID>"}'
```

Required: `name` (max 100 chars) and `workdir` (existing directory; use an absolute path). For a new session, `task` is optional: when omitted, Pi opens interactively with an empty editor; when supplied, it runs as the initial instruction. When delegating work, supply a specific task so the worker knows what to do. Optional: `parentId`, the ID of the delegating agent. Supplying `parentId` **automatically creates a directed `delegates` edge** from parent to child. The response contains the new agent's ID. Omit `parentId` to create an independent agent. Each agent has its own Pi process; both can work in the same directory, so coordinate edits to avoid conflicts. Pi saves conversations and Canvas auto-saves node metadata, layout, notes and relationships.

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

## Rename an existing Canvas node

```sh
curl -fsS -X PATCH "$AGENT_CANVAS_URL/api/agents/<AGENT_ID>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"staging-tester"}'
```

Names must be non-blank and at most 100 characters; surrounding whitespace is trimmed. This changes only the Canvas node name, not Pi's saved session name. The node ID, running process, conversation and edges remain unchanged—do not replace the session to rename it. SHM messaging uses Agent IDs, not names; names need not be unique. Rename another agent only when asked.

## Restore and reset

On server restart, previously running agents reopen their recorded session without sending a prompt or replaying interrupted work. A missing/invalid session falls back to Pi's picker. Missing workdirs leave stopped nodes with `restoreWarning`. Previously stopped nodes stay stopped. `POST /api/agents/:id/resume` reopens a stopped node's conversation (or picker), retaining its ID and edges. Do not resume another agent unless asked.

`POST /api/canvas/reset` with `{"confirm":true}` stops only Agent Canvas agents and clears its nodes/notes/edges/placements. The Card box agent, layouts and library are preserved. **Only do this when the user explicitly requests resetting the entire Canvas.** Pi sessions and project files are not deleted. The browser provides confirmation; API clients must obtain user confirmation themselves.

Session identity and working/idle reports are automatic through the process-scoped SHM telemetry channel. Channel identity/generation and monotonic process-wide sequences fence stale reports. `sessionFile` and `sessionId` identify the conversation, not the Canvas node, and are excluded from public awareness snapshots; explicit metadata queries may return them.

- `POST /api/agents/:id/stop` terminates a Pi process. `DELETE /api/agents/:id` removes a **stopped** node and its relationships from this canvas, but does not delete its saved Pi session. Don't stop or remove another agent unless explicitly asked.
