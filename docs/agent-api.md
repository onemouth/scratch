# Agent Canvas — Agent API Guide

You can use the Agent Canvas API to observe the shared canvas, create Pi agents, send explicit messages to running agents, and record **real delegation relationships**. Canvas-launched Pi agents use SHM tools for summaries, precise metadata/layout queries, subscriptions, peer messaging and own-progress reports. Use the HTTP commands below for full state, lifecycle/layout/content operations, card source and media. This server binds to loopback on the user's machine. Optional private Tailscale Serve access is configured by the human; do not change network exposure, Serve/Funnel or access policies as part of Canvas API work.

## Locate the server and your identity

- This web guide substitutes the **current running API URL** into every command below, so you can copy it into an agent as-is. Canvas-launched agents use the same-machine `127.0.0.1` API URL. A browser-facing guide can instead show the human's explicitly configured HTTPS tailnet URL; those commands require a permitted Tailscale device. Never replace a Canvas agent's loopback URL with the browser URL.
- Canvas-launched agents receive the `agent-canvas` skill via Pi's `--skill` option and have `AGENT_CANVAS_URL` and `AGENT_CANVAS_ID` (their own node ID) in their environment. The skill points to this live guide; it does not install anything globally.
- If this guide was pasted into a different agent, tell it whether it has a Canvas node, and provide that node's ID if so. **Do not assume an external agent already has a node**: agents not launched by the Canvas do not have `AGENT_CANVAS_ID`.
- Canvas-launched agents can also fetch this guide: `curl -fsS "$AGENT_CANVAS_URL/api/docs"`.
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

SHM is required on macOS/Linux, requires a locally built native addon (npm startup commands build it automatically), and is passed to new/restored Pi processes. Missing/stale/busy/incompatible memory returns an explicit tool error, never an implicit HTTP fallback. Use canvas_agents for precise Agent metadata and canvas_layout for current geometry/busy observations. Keep HTTP for this complete guide, /api/state, mutations (which atomically validate geometry/busy), terminal output and full card reads. Do not enable/restart services or relaunch other agents without permission. See [shared-memory setup and limits](shared-memory.md).

### Agent event subscriptions

If canvas_subscribe is available, register future Agent events and continue working: `{agentId,events?:["started"|"working"|"idle"|"stopped"|"removed"|"progress"],delivery?:"notification"|"nextTurn"|"followUp",wake?:false,once?:false,generation?:"..."}`. Defaults are idle/stopped/removed events and UI-only notification, without a model call. nextTurn queues context without waking; followUp requires once:true, cannot target yourself and may queue another model continuation; wake:true additionally permits starting an idle model and is only accepted with followUp. Do not create automatic wake cycles. Idle is not success. The target must exist; already-idle does not fabricate an event. Registration returns subscriptionId, serverEpoch, cursor, active and explicit scope (logical agent ID across restarts unless generation-filtered). At most 32 subscriptions per Pi session; not persisted across reload/shutdown. `canvas_unsubscribe({subscriptionId})` cancels one, or use `"*"` to cancel all in this session. No other Agent is stopped or changed.

Named-semaphore wakeups cause the extension to read the 256-record SHM journal, preserving fast transitions independently of browser snapshot coalescing. Missing/stale memory, journal overrun and excessive notification bursts are explicit errors; do not infer an outcome. Subscriptions notify Agent lifecycle/activity/progress, not arbitrary card/layout changes. See [complete notification semantics](canvas-notifications.md).

## Agent metadata, layout and terminal output

- canvas_agents({offset?,limit?}) returns exact runtime metadata in {agents,total,offset,nextOffset}; canvas_agents({agentId}) returns {agent}. No output. Metadata can include complete task/session fields omitted from canvas_read summaries.
- canvas_layout({offset?,limit?}) returns current geometry and busy flags in {objects,total,offset,nextOffset}. Each page is sampled independently by Scratch, with source, serverEpoch and sampledAt. Follow nextOffset; busy is not a reservation.
- Default page size 20, maximum 100; response frames at most 60000 UTF-8 bytes. Byte limits may shorten pages; individual oversized records fail with QUERY_CAPACITY, never silent truncation. No automatic retry or HTTP fallback.
- See the [SHM query contract](agent-queries.md) for data, limits and lifecycle semantics.
- GET /api/state returns Canvas state without terminal output. Browsers receive state updates through SSE and terminal replay through WebSocket.
- GET /api/agents/:id/output returns {id,output,maxCharacters:80000} for running or stopped agents. This is the recent bounded **raw ANSI terminal tail**, not a conversation transcript; truncation can start mid-escape-sequence. Reading does not clear it; Resume resets it. Missing targets return 404.
- Collection/search/state responses omit Interactive Card source. Read GET /api/cards/:id when full source is needed.

```sh
curl -fsS "$AGENT_CANVAS_URL/api/agents/<AGENT_ID>/output"
```

## Card box

Cards are independent of sticky notes. Read all card summaries with `GET /api/cards` (returns `{cards: [...]}`, newest ID first), or one complete card with `GET /api/cards/:id`. Interactive source is intentionally omitted from collection/search/state snapshots; fetch that card by ID when source is required. Every card contains `id`, `type`, `tags`, `links`, `createdAt`, and `updatedAt`. A `markdown` card additionally has `content`, `units`, and nullable `image`/`audio` attachment metadata. An `interactive` card instead has `title`, `{html,css,javascript,revision}` under `interactive`, and an `assets` array. IDs are assigned by the server from its local date plus a daily non-reused sequence (`YYYY-MM-DD-0001`) and cannot be changed.

- `POST /api/cards`: `{"content":"**One idea**","tags":["reading"],"links":["<EXISTING_CARD_ID>"],"place":true}` creates a Markdown card. All fields are optional; defaults are `type:"markdown"`, empty content/tags/links and `place:true`. `{"type":"interactive","title":"Orbit","html":"<canvas></canvas>","css":"canvas{width:100%;height:100%}","javascript":"/* interaction */","tags":[],"links":[],"place":true}` creates an interactive card; title and non-empty HTML are required. Returns the card (201). Every new card joins the shared current Card box view, regardless of whether it was created by UI or API. If the fixed Unfiled system view is current, the card remains without an ordinary-view membership and appears dynamically in Unfiled. With `place:false`, it has no Agent Canvas node. Other Card box views are unchanged.
- `PATCH /api/cards/:id`: Markdown cards accept only `content`, `tags` and/or `links`. Interactive cards accept `title`, `html`, `css`, `javascript`, `tags` and/or `links`. Source fields are complete replacements, not patches. Optional creation geometry (`x,y,width,height`) belongs only to the Agent Canvas placement; change an existing card's geometry via `/api/card-placements/:id`, not this content endpoint. Type and ID are immutable. Updates are atomic.
- `DELETE /api/cards/:id`: requires `{"confirm":true}`; **permanently deletes** the card and any placement.
- `POST /api/cards/:id/placement` with `{}`: place an existing library card on the Canvas, idempotently. Optional `x,y,width,height` may be supplied for a new placement; supplying geometry when already placed returns 409 (use PATCH instead). Returns its placement. Each card has at most one placement in Agent Canvas, independent of its Card box placement.
- `DELETE /api/card-placements/:id` with `{}`: remove only the placement, preserving the card.
- `PATCH /api/card-placements/:id`: agents may update Agent Canvas `x,y,width,height` (minimum 240×240; interactive width minimum 320), subject to collision and human-gesture checks below. Card Box placements are unchanged.

Content supports text Markdown (headings, emphasis, lists, blockquotes, code, normal links) and KaTeX-compatible math: `$...$` inline, `$$` on separate lines for display, or a fenced `math` block. Escape literal currency dollars as `\$`. Store the original math source in `content`. Invalid formulas remain valid card source and display errors in the UI; trusted HTML/external resources in TeX are disabled. Images embedded in Markdown and raw HTML are still rejected. Limit: **400 text units**, CJK graphemes individually plus non-CJK words using Unicode word segmentation. Formatting, whitespace, punctuation and link destinations do not count. Ordinary code counts as text. Math source argument text, variables and numbers count too, but dollar delimiters and backslash-letter command names do not; arguments of `\text{...}` still count. Math fences use the same rule. Source is limited to 20,000 characters. Tags are a flat array of at most 30 unique trimmed strings, each at most 60 characters, no commas/newlines. Empty content is allowed. `links` is an array of up to 100 card IDs, trimmed and deduplicated; self-links and new references to absent cards return 400. Links are bidirectional metadata, not delegation or Canvas edges. Adding A → B automatically adds B → A; removing it from either card removes both. Creation/update commits all affected cards in one transaction and updates their timestamps; exceeding the 100-link limit on a reverse-link target returns 400 and rolls back the entire operation. Snapshots/GET reflect updated cards on both sides. Startup migration fills missing reverse links in existing libraries. Existing references to deleted cards remain stored and may be retained in later updates; setting `links: []` clears them. Links and tags are outside the content-unit limit.

Interactive cards are agent-authored sandboxed mini web pages. Humans can edit title/tags/links but have no source editor. HTML is limited to 250 KiB, forbids script/style/nested browsing/navigation/form elements and audio/video autoplay, and permits only `card-asset://`, `data:` or local-fragment HTML resource URLs; CSS is limited to 100 KiB; JavaScript is limited to 2 MiB. Put all executable code in `javascript`. **JSXGraph 1.14.1 is built in locally**: use `JXG.JSXGraph.initBoard('board', {...})` directly with a percentage-sized `.jxgbox` div; no library declaration, imports or script/CDN tags. It runs only after Play, defaults to SVG and resizes with its container. Use JS functions (e.g. `board.create('functiongraph', [x => x*x])`), not expression strings requiring eval. External readers/MathJax/KaTeX, arbitrary libraries and WASM remain unsupported. See `interactive-cards.md` for a complete slider/graph payload. Pure HTML/CSS/SVG renders immediately; JavaScript and CSS animation require human Play. Source is isolated from Canvas APIs, storage, parent DOM, network, workers, external libraries and device permissions. Use responsive HTML/CSS, SVG `viewBox`, and a `resize` listener for Canvas redraw. Sandbox permissions do not impose a CPU/memory quota: never generate unbounded loops or allocation, and treat Play as the human trust boundary. See [Interactive cards](interactive-cards.md).

Private assets are imported—not linked—from `~/Documents/agent-canvas/media/images`, `audio`, or `video`: `POST /api/cards/:id/interactive-assets/import` with `{"kind":"image|audio|video","source":"safe/relative/path.png","name":"logical-name"}`. Reference them as `card-asset://logical-name`. Names are unique per card. `DELETE /api/cards/:id/interactive-assets/:name` with `{}` removes one. Each file is at most 25 MiB and each card at most 100 MiB. Permanent interactive-card deletion removes its private copies. Agents must use these endpoints, never write the SQLite/private-asset directory directly.

Validation errors return 400; absent cards/placements return 404. Only create or modify the user's cards when asked. Library contents persist in SQLite independently of the Canvas JSON; removing a placement or resetting the Canvas does not delete library cards. Do not interpret cards as delegation relationships.

## Card attachments (human UI)

Each card has at most one image and one audio. `image` and `audio` are either `null` or `{id, kind, name, mime, size, createdAt, url}`. `name` is the original filename; `size` is bytes; `url` is a same-origin relative `/api/card-files/:id` URL, not an external URL or filesystem path. Attachments are independent of Markdown and do not count toward 400 text units. Normal card POST/PATCH cannot set these fields.

The browser supports dragging JPEG/PNG/WebP/GIF (10 MB) or MP3/M4A/WAV/OGG (50 MB) onto a card, not empty Canvas. It renders audio → image → text; metadata includes unlink controls. Switching Canvas preserves playback, and only one audio plays at a time.

Browser transport endpoints (not agent upload tools in this version):
- `PUT /api/cards/:id/media/image` or `/audio`: raw file bytes, with `X-File-Name` containing the URI-encoded original filename. Replacements require `If-Match` containing the current attachment UUID (unquoted). An empty slot must omit it. The slot is checked before and after streaming; stale replacements return 409. Successful uploads return the updated card, and SSE refreshes both modes.
- `DELETE /api/cards/:id/media/image` or `/audio` with `{"attachmentId":"<CURRENT_ATTACHMENT_UUID>"}`: unlink only, returning the updated card. A stale ID returns 409.
- `GET`/`HEAD /api/card-files/:id`: serve registered files using their actual detected MIME type, nosniff, immutable IDs and single byte-range support for seeking. Invalid ranges return 416. Missing files or byte-size mismatches return 404; oversized uploads return 413, unsupported formats 415, invalid names/empty files 400.

Files live in `images/` and `audios/` alongside SQLite. Replacing/unlinking attachments or permanently deleting cards **retains accepted file bytes and metadata** for a future audit; failed/uncommitted uploads are cleaned up. Stored ordinary attachment files have no audit/deletion API. Reset/removing a Canvas placement does not unlink attachments. Agents may read attachment metadata but must not use upload/unlink transport, write files directly into these directories, or alter attachment tables in this version.

## Card box workspace lifecycle (human UI)

Card box displays only the shared current view's cards in `state.cardBox.placements`. New library cards join this view in free grid slots without rearranging existing cards. The fixed Unfiled view dynamically displays cards with no membership in any other saved or temporary view. Permanent card deletion removes its Agent Canvas placement and memberships in every view. The shared Card box agent lives in a collapsible right sidebar, not a draggable canvas node. The dock does not use the agent's stored coordinates. Switching views/workspaces or hiding the sidebar does not stop or remount its terminal/session.

- `POST /api/card-box/agent` with `{}`: create its single fixed New-session Pi agent in the database directory. Returns 201; subsequent launch attempts return 409. The agent appears in `state.agents` with `workspace: "card-box"`.
- Use existing `/api/agents/:id/stop` and `/resume` for its lifecycle. Removal is rejected (409); delegation to/from it is rejected (400), including creating a child with its `parentId`.
- `PATCH /api/card-box/placements/:cardId`: compatibility endpoint for human layout updates in the current view. New clients should use the explicitly view-scoped route below to avoid updating a different view after a switch.

Switching workspaces does not stop agents. Agent Canvas reset preserves Card box agent, views and library. Use APIs, never directly edit SQLite, Canvas JSON, backup or lock files.

## Card library search and views

First fetch `GET /api/card-box/views`. If it returns 404, this running backend has not loaded the view feature: tell the human and do not guess endpoints, alter files, or restart agents yourself.

- `GET /api/cards?q=<URL_ENCODED_QUERY>&limit=24&offset=0`: returns `{cards,total,limit,offset}`, newest ID first. Search matches **any** whitespace-separated term (OR), case-insensitive Unicode-normalized substring matching over Markdown content or interactive title, plus tags and ID. Empty query browses the library. Query ≤1,000 characters; limit 1–100; offset ≥0. Without `q`, the existing endpoint still returns all cards. Search is literal, not a natural-language or fuzzy search engine; agents interpret the user's intent and select relevant IDs.
- `GET /api/card-box/views`: returns `{epoch,revision,activeViewId,placements,views}`. Each view has `{id,name,saved,viewport,placements}`; the fixed system view additionally has `system:"unfiled"` and persisted `cachedPlacements`. IDs are opaque server-assigned values. The top-level placements mirror the current view. All browsers/agents share the active view; workspace selection remains local to each browser.
- `POST /api/card-box/views`: `{"name":"Cryptography","cardIds":["<EXISTING_CARD_ID>"],"fromViewId":"<CURRENT_VIEW_ID>"}`. Creates and activates a **temporary** view (201). Name and cardIds are optional; defaults are unnamed and empty. Existing cards are not copied or edited; other views retain their memberships/layouts. New view cards receive server-selected initial slots, not agent-provided coordinates.
- `POST /api/card-box/views/:id/activate`: `{"fromViewId":"<CURRENT_VIEW_ID>"}`. Activates an existing saved view for all Card box clients.
- **Leaving a temporary view**, through creation or activation, requires an explicit choice: add `"temporaryAction":"save","saveName":"Unique name"` or `"temporaryAction":"discard"`. Without a choice, or with a stale fromViewId, the operation returns 409 and changes nothing. Ask the human before discarding/replacing their temporary work; never automatically retry a 409 with discard. Validate/re-read current view after a conflict.
- The fixed **Unfiled** system view cannot be renamed, saved, deleted, or changed through membership POST/DELETE (409). It automatically gains cards removed from their last ordinary view and loses cards added to another view. Its cached layout is restored if a card becomes unfiled again. It may be activated and its human layout/viewport may be changed normally.
- `POST /api/card-box/views/:id/save`: `{"name":"Unique name"}` makes that temporary view saved. Saved views subsequently autosave membership, layout and viewport changes.
- `PATCH /api/card-box/views/:id`: `{"name":"New name"}` renames it. Names ≤120 characters; saved names must be non-empty. Names are unique under Unicode normalization/case folding. Only the active view may be temporary; it survives refresh and normal backend restart when Canvas persistence is enabled, but is not a saved dropdown entry until Save.
- `POST /api/card-box/views/:id/cards/:cardId` with `{}`: idempotently adds an existing card.
- `DELETE /api/card-box/views/:id/cards/:cardId` with `{}`: removes only that membership/placement, **not** the library card or other views. This is what “remove from this view” means. Do not substitute permanent card deletion.
- `DELETE /api/card-box/views/:id`: `{"confirm":true,"fromViewId":"<CURRENT_VIEW_ID>"}`. Requires human confirmation. fromViewId is required when deleting the active view. Deletes only the view; cards, attachments and agent remain. Cards that then have no other membership appear in Unfiled. Deleting the active view opens another saved view (at minimum Unfiled).
- **Human layout only**: `PATCH /api/card-box/views/:id/cards/:cardId` with `x,y,width,height` (minimum 240); `PATCH /api/card-box/views/:id/viewport` with `{x,y,zoom}` (zoom 0.2–2). **Agents must not modify positions, sizes or viewport coordinates.** The same card's placements are independent between views.

Views, temporary work and Unfiled's layout cache use Canvas JSON schema 4; card contents use SQLite schema 5. Supported older saves migrate on normal startup, preserving existing placements and agents. Missing cards are pruned, never recreated. Save errors remain visible through persistence.error; ordinary card-editor drafts are separate and still not persisted across page reload.

For a request like “create a view about cryptography,” read current view metadata, search/read library cards, choose appropriate existing IDs, then create a named temporary view. It opens immediately in Card box. For “add/remove DH here,” read activeViewId, identify the card, and use the membership endpoints for that ID. Preserve other views and never send an initial task or recreate the shared agent.

## Agent Canvas layout

Agents may directly position/resize **any** Agent Canvas Card, Note or Agent, regardless of creator, without extra human confirmation. This permission covers geometry only, not someone else's content, agent lifecycle or deletion. Card Box remains human-layout-only.

Use canvas_layout({offset?,limit?}) for paginated {objects:[{kind,id,x,y,width,height,busy}],total,offset,nextOffset,source,serverEpoch,sampledAt} in unzoomed canvas units (negative positions allowed). When creating via `POST /api/agents`, `/api/notes`, or `/api/cards`, optional top-level `x,y,width,height` specify the Agent Canvas rectangle. Cards require `place:true` or omitted; `place:false` plus geometry is rejected. Without explicit geometry, the server uses default placement. Explicitly positioned API agent launches do not steal focus or move the viewport.

Update one object via `PATCH /api/agents/:id`, `/api/notes/:id`, or `/api/card-placements/:id`. Omitted geometry is preserved. Minimum sizes: agent 320×240, note 160×160, Markdown card 240×240, interactive card 320×240. No batch operation or undo is provided. Existing-object API layout changes do not pan/zoom the human's view.

The complete resulting rectangle must not overlap other Agent Canvas objects; touching edges is allowed. This applies even to targets already overlapping because a human put them there. On overlap, return 409 with `code:"LAYOUT_CONFLICT"` and `conflicts:[{kind,id,x,y,width,height}]`. During a human drag/resize of the target, return 409 with `code:"LAYOUT_BUSY"` and `object:{kind,id}`; retry later. Rejections are atomic (including combined metadata changes); rejected creation creates no library/view entry or PTY. No implicit adjustment to a nearby slot occurs.

Human gestures may still overlap. The browser uses an explicit `X-Canvas-Layout: human` intent marker and temporary gesture leases. **Agents must not set that marker or call `/api/canvas/layout-interactions/...`**. These are cooperative transport rules, not authentication; this loopback API has no auth system. See [complete layout contract](agent-canvas-layout.md) for examples, human lease expiry and details.

## Delegate work to a new Pi agent

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

## SHM agent-to-agent messaging

When available, use `canvas_send_message({agentId,text})` rather than terminal paste/HTTP. Scratch routes your dedicated SHM outbox to the target process mailbox; native semaphores notify receivers. Default nextTurn does not wake; followUp/wake is explicit and rate/lifetime-budget limited. The tool returns queued with a message ID; `canvas_message_status({messageId})` reads later receipts without waiting. Accepted means Scratch enqueued the pinned target generation; delivered only means the receiver invoked Pi's custom-message API, not read/answered/completed. Do not automatically resend uncertain outcomes or create reply/wake loops. Maximum text is 8000 UTF-8 bytes. No HTTP fallback, persistence or restart replay. Messaging is process-scoped: reload/new/resume/fork retains channels, pending messages and receipts, then rebinds handoff to the current Pi context. No process relaunch is needed for a session change. See [full messaging contract](agent-messaging.md).

## Pending inbox (read-only browser view)

Each Agent header, including the Card box dock, opens a read-only inbox popover with sender, waiting time and full literal text. It shows only unresolved messages, not a receipt history. Pi API handoff does not remove a message: the process must observe its exact peer envelope in the model context and outgoing payload, followed by response content or a successful response end. Request failures/abort before response do not count. This is inclusion evidence, not task completion or an acknowledgment from the model.

Live Agent state includes an `inbox` summary `{state,count,revision,generation,reason?,previousUnconfirmed?}`. `count:null` means unavailable, never zero. `GET /api/agents/:id/inbox` returns this summary plus `messages:[{messageId,sourceId,sourceName,text,receivedAt,state}]`; item state is pending or uncertain. Reads never wake, mark consumed, send or replay anything; writes return 405. This browser content read does not add a SHM tool. Process end is unavailable; a new generation has fresh rows and an unresolved-previous-process warning when needed. Nothing is persisted or replayed across server restart. Capacity limits are 64 rows per recipient / 1024 total; exhaustion rejects new sends with MESSAGE_INBOX_FULL rather than evicting pending rows. See [full inbox contract](agent-inbox.md).

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

## Update your progress note

Use `canvas_set_progress({text:"Reviewing SHM synchronization"})` for your own progress. It enqueues only your own note through a dedicated process-scoped Pi → Scratch SHM channel, independent of peer messaging. Empty text clears it; maximum 500 JS UTF-16 code units. Queued is not applied or saved; Scratch validates/applies the update, with background receipts/UI warnings. Use canvas_read for observed state when needed, not polling. No automatic resend or HTTP fallback after a failed/unknown send. Session/activity reports are automatic through this same telemetry transport. Reload/new/resume/fork preserves transport and sequences. Temporary `SHM_STALE` pauses writes; the original epoch's heartbeat recovery resumes the same channel and freshly samples current session/activity, never replaying old progress/reports or waking a model. Closed/missing/replaced generations remain fenced. See [telemetry contract](agent-telemetry.md).

Progress notes use only SHM telemetry. Agent HTTP PATCH accepts name and Agent Canvas geometry; validation failures reject the entire update.

Agent progress notes are at most 500 characters and appear on the node. Only update **your own** progress note. Independently, Agent Canvas `x,y,width,height` may be adjusted on any agent through the layout contract above; Card Box geometry remains human-only.

## Canvas sticky notes

Sticky notes are independent text nodes, not agents or delegation targets. `POST /api/notes` creates one with optional `title` (1–100 characters, trimmed, defaults to `Note`) and `text` (up to 10,000 characters, empty allowed). `PATCH /api/notes/:id` updates its `title` or `text`; `DELETE /api/notes/:id` removes it. State includes `notes` with `id`, `title`, `text`, and layout fields. The UI displays only body text; `title` remains stored and supported by the API for compatibility, but is not shown or editable in the UI. Layout fields (`x`, `y`, `width`, `height`; minimum size 160) may be supplied at creation or adjusted by agents under the collision/human-gesture rules above. Notes are auto-saved across server restarts. Only edit note text/title or remove a user's note when asked; layout-only changes need no extra confirmation.

## Restore and reset

On server restart, previously running agents reopen their recorded session without sending a prompt or replaying interrupted work. A missing/invalid session falls back to Pi's picker. Missing workdirs leave stopped nodes with `restoreWarning`. Previously stopped nodes stay stopped. `POST /api/agents/:id/resume` reopens a stopped node's conversation (or picker), retaining its ID and edges. Do not resume another agent unless asked.

`POST /api/canvas/reset` with `{"confirm":true}` stops only Agent Canvas agents and clears its nodes/notes/edges/placements. The Card box agent, layouts and library are preserved. **Only do this when the user explicitly requests resetting the entire Canvas.** Pi sessions and project files are not deleted. The browser provides confirmation; API clients must obtain user confirmation themselves.

Session identity and working/idle reports are automatic through the process-scoped SHM telemetry channel. Channel identity/generation and monotonic process-wide sequences fence stale reports. `sessionFile` and `sessionId` identify the conversation, not the Canvas node, and are excluded from public awareness snapshots; explicit metadata queries may return them.

## Other interfaces and boundaries

- `GET /api/session-workdirs` lists existing workdirs referenced by saved Pi session headers (used by the web UI's workdir dropdown; it does not read conversation content).
- `GET /api/events` is a Server-Sent Events stream of canvas snapshots (used by the web UI).
- `WS /api/terminal/:id` streams PTY output and accepts raw terminal input and resize messages (used by the web UI). Use canvas_send_message for agent-to-agent messages.
- `POST /api/agents/:id/stop` terminates a Pi process. `DELETE /api/agents/:id` removes a **stopped** node and its relationships from this canvas, but does not delete its saved Pi session. Don't stop or remove another agent unless explicitly asked.
- Calls return JSON; failures return `{ "error": "..." }` with a non-2xx HTTP status. `curl -f` treats these as errors.
- There is **no automatic message passing** and no authentication. A single local Canvas is auto-saved; restoration reopens conversations, not in-flight tasks. Use the API only against the user's configured Canvas server and record relationships only for actual work. Canvas-launched agents must keep using their supplied loopback URL.
