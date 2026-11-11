# Canvas awareness and precise queries

You can use the Agent Canvas API to observe the shared canvas, create Pi agents, send explicit messages to running agents, and record **real delegation relationships**. Canvas-launched Pi agents use SHM tools for summaries, precise metadata/layout queries, subscriptions, peer messaging and own-progress reports. Use the HTTP commands below for full state, lifecycle/layout/content operations, card source and media. This server binds to loopback on the user's machine. Optional private Tailscale Serve access is configured by the human; do not change network exposure, Serve/Funnel or access policies as part of Canvas API work.

## Locate the server and your identity

- Canvas-launched agents use their supplied same-machine `AGENT_CANVAS_URL`. The browser's full guide substitutes a running URL into examples and may show the human's explicitly configured HTTPS tailnet address. Never replace an Agent's loopback URL with that browser-facing address.
- Canvas-launched agents receive the `agent-canvas` skill via Pi's `--skill` option and have `AGENT_CANVAS_URL` and `AGENT_CANVAS_ID` (their own node ID) in their environment. The skill selects local task-specific references; it does not install anything globally.
- If this guide was pasted into a different agent, tell it whether it has a Canvas node, and provide that node's ID if so. **Do not assume an external agent already has a node**: agents not launched by the Canvas do not have `AGENT_CANVAS_ID`.
- Use the bundled references for normal tasks. Fetch the full live guide only for missing/ambiguous contracts or a suspected backend-version mismatch: `curl -fsS "$AGENT_CANVAS_URL/api/docs"`. Do not routinely fetch it or guess unsupported routes.
- The API accepts JSON. Replace `<...>` placeholders in the examples. Only use an existing directory for `workdir`.

## Interfaces

| Purpose | Interface |
| --- | --- |
| Canvas summaries | `canvas_read` |
| Exact Agent metadata | `canvas_agents` |
| Current geometry / human busy observations | `canvas_layout` |
| Future Agent events | `canvas_subscribe` / `canvas_unsubscribe` |
| Peer messages / receipts | `canvas_send_message` / `canvas_message_status` |
| Own progress | `canvas_set_progress`; session/activity reporting is automatic |
| Full state / terminal tail | `GET /api/state` / `GET /api/agents/:id/output` |
| Lifecycle, layout, content and views | HTTP operations documented below |

SHM tools are provided to Canvas-launched Pi processes. External HTTP clients can read full state and use the documented HTTP operations. Neither transport is an authentication boundary.

## Read the canvas

```sh
curl -fsS "$AGENT_CANVAS_URL/api/state"
```

Returns `{ "agents": [...], "edges": [...], "notes": [...], "cards": [...], "cardPlacements": [...], "cardBox": { "epoch": "...", "revision": 0, "activeViewId": "...", "placements": [...], "views": [...] }, "persistence": { "enabled": true, "error": "" } }`. Agents have `workspace` (`agents` or `card-box`; absent on older records means `agents`), `id`, `name`, `workdir`, `task`, process `status` (`running`, transient `stopping`, or `stopped`), live `activity` (`unknown`, `working`, or `idle`), `note` and layout fields. This status query intentionally omits terminal `output`; read it on demand using the endpoint below. `activity` is transient and resets to `unknown` on restart until Pi reports its state; an `idle` agent is available for more work, not stopped. A live idle snapshot may also include `notificationSummary`, a short final-response preview used only for browser notifications and never persisted. Edges have `id`, `source`, `target`, `type: "delegates"`, and a human-editable `label` (default `"delegates"`). Node IDs can be found here; don't guess them.

## Canvas summaries (SHM)

Canvas-launched Pi processes provide `canvas_read` to read paginated Canvas summaries directly from POSIX shared memory without HTTP. Optional parameters: `section` (`all`, `agents`, `edges`, `notes`, `cards`, `cardPlacements`), `offset` (default 0), `limit` (default 20, maximum 100). Follow each section's `nextOffset`. Results are bounded to 40 KB and include a generation and revision; notes/cards are summaries, not full source. Output, prompts, session tokens/paths, Interactive source/assets and Card Box view state are excluded. Metadata can lag its latest server mutation by the existing publication coalescing interval; this is not the full `/api/state` contract or an authoritative human-gesture lease check.

SHM is required on macOS/Linux, requires a locally built native addon (npm startup commands build it automatically), and is passed to new/restored Pi processes. Missing/stale/busy/incompatible memory returns an explicit tool error, never an implicit HTTP fallback. Use canvas_agents for precise Agent metadata and canvas_layout for current geometry/busy observations. Keep HTTP for /api/state, mutations (which atomically validate geometry/busy), terminal output and full card reads. Do not enable/restart services or relaunch other agents without permission.

## Agent metadata, layout and terminal output

- canvas_agents({offset?,limit?}) returns exact runtime metadata in {agents,total,offset,nextOffset}; canvas_agents({agentId}) returns {agent}. No output. Metadata can include complete task/session fields omitted from canvas_read summaries.
- canvas_layout({offset?,limit?}) returns current geometry and busy flags in {objects,total,offset,nextOffset}. Each page is sampled independently by Scratch, with source, serverEpoch and sampledAt. Follow nextOffset; busy is not a reservation.
- Default page size 20, maximum 100; response frames at most 60000 UTF-8 bytes. Byte limits may shorten pages; individual oversized records fail with QUERY_CAPACITY, never silent truncation. No automatic retry or HTTP fallback.
- GET /api/state returns Canvas state without terminal output. Browsers receive state updates through SSE and terminal replay through WebSocket.
- GET /api/agents/:id/output returns {id,output,maxCharacters:80000} for running or stopped agents. This is the recent bounded **raw ANSI terminal tail**, not a conversation transcript; truncation can start mid-escape-sequence. Reading does not clear it; Resume resets it. Missing targets return 404.
- Collection/search/state responses omit Interactive Card source. Read GET /api/cards/:id when full source is needed.

```sh
curl -fsS "$AGENT_CANVAS_URL/api/agents/<AGENT_ID>/output"
```

## Other interfaces and boundaries

- `GET /api/session-workdirs` lists existing workdirs referenced by saved Pi session headers (used by the web UI's workdir dropdown; it does not read conversation content).
- `GET /api/events` is a Server-Sent Events stream of canvas snapshots (used by the web UI).
- `WS /api/terminal/:id` streams PTY output and accepts raw terminal input and resize messages (used by the web UI). Use canvas_send_message for agent-to-agent messages.
- Calls return JSON; failures return `{ "error": "..." }` with a non-2xx HTTP status. `curl -f` treats these as errors.
- There is **no automatic message passing** and no authentication. A single local Canvas is auto-saved; restoration reopens conversations, not in-flight tasks. Use the API only against the user's configured Canvas server and record relationships only for actual work. Canvas-launched agents must keep using their supplied loopback URL.
