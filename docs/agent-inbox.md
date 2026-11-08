# Agent pending inbox

Each Agent header, including the Card box dock, has a number-only pending-count button (or ? when unavailable). It opens a small viewport-clamped popover showing sender, waiting time and full message text. It is strictly read-only: viewing, scrolling and closing never wake a model, send terminal input, reply, delete, replay or mark a message as consumed. Escape closes the popover and returns focus to its button. Peer text is rendered literally, not as HTML or Markdown instructions.

## Pending boundary

The inbox tracks messages accepted by Scratch for one pinned Pi process generation. Acceptance and the `delivered` transport receipt do not remove them. In particular, default nextTurn messages may wait in Pi after the SHM mailbox has drained.

Removal requires all of:

1. The exact known peer message and its messageId/source identity occur in the model turn's context (`context_with_system`).
2. Its complete peer envelope occurs in the outgoing provider payload (`before_provider_request`). A UUID appearing in unrelated text is insufficient.
3. Pi reports a nonempty response text/thinking/tool-call delta, or a successful assistant response end, for that context.

The response signal prevents an authentication/request failure, a synthetic error message or an abort before any response from falsely emptying the inbox. A failure after response has begun does not put an already-included message back. This is conservative evidence of inclusion in a responding model turn, **not** proof of reading, understanding, answering or task completion. It does not wait for a reply or for the whole task to finish. Working/idle transitions and successful unrelated work never imply inclusion.

Custom providers must honor Pi's request instrumentation. A provider/extension that suppresses or rewrites the relevant context/payload/signals can leave a message unconfirmed; the inbox does not guess or re-inject it. Compaction/edited context is not treated as proof that the original message entered a normal turn.

An explicit receiver expiry before Pi handoff removes a never-handed message. The transport TTL is not a deadline for Pi's nextTurn queue: a handed-off message remains pending beyond that TTL. Lost/late handoff evidence is shown as uncertain; a late, identity-checked receiver expiry can resolve it without changing the sender's earlier unknown receipt.

## Session and process boundaries

Tracking and SHM reports are process-owned across reload/new/resume/fork. Only the current extension binding observes context; detached bindings cannot report inclusion. Handed-off unresolved messages are marked unconfirmed at a session/runtime transition, because Pi owns its session queues and the Canvas cannot promise they survived. They are never automatically resent. A later exact model-context observation can resolve them.

When the process ends, the view is unavailable, not a successful empty inbox; unresolved rows remain inspectable in memory. A replacement process has a fresh inbox and never receives those rows. Its summary carries a previousUnconfirmed warning if an earlier generation ended with unresolved messages. The warning is not message history. Tracking is ephemeral: server restart loses this projection, with no disk storage or restart replay. Removing a Canvas node releases its retained rows.

`?` means the count cannot be confirmed, including missing tracking support, startup before the readiness report, a protocol/sequence gap or a closed process. Empty success is shown only for a confirmed active inbox.

## Browser read interface

Live `/api/state` and SSE Agent metadata include only:

```js
inbox: {
  state: "active" | "unavailable",
  count: 0,           // null when unavailable
  revision: 1,
  generation: "<process-generation>", // null without a tracked generation
  reason: "...",     // when unavailable
  previousUnconfirmed: true // optional
}
```

`GET /api/agents/:id/inbox` returns the same summary fields plus:

```js
messages: [{
  messageId: "<message-id>",
  sourceId: "<sender-id>",
  sourceName: "Sender", // captured at acceptance, retained if sender leaves
  text: "Peer data",
  receivedAt: 0,        // server Unix milliseconds at acceptance
  state: "pending" | "uncertain"
}]
```

Missing Agents return 404; writes return 405. Reads have no mutation side effects. The browser requests text only while the popover is open and refreshes on generation/revision changes. It aborts obsolete reads and checks response identity/revision; a stale, malformed or failed read is not rendered as an empty success. The ordinary terminal may independently display custom messages; this interface adds no inbox payload fields to SSE, public SHM summaries, metadata queries or Canvas JSON. It adds no Agent tool or lifecycle-event subscription type. This is a same-user local UI interface, not an authentication boundary.

## Bounds and ownership

Scratch owns the pending projection and validates process-inferred inclusion facts. There are at most **64 unresolved rows per recipient** and **1024 across the server**, with the messaging text limit of 8000 UTF-8 bytes. Capacity exhaustion rejects new messages before mailbox enqueue with `MESSAGE_INBOX_FULL`; it never silently evicts pending rows. A closed process's unresolved rows count toward the total until its replacement starts or the node is removed.

The private channel configuration advertises inboxVersion:1. Observation facts use the recipient's existing independent 1 KiB ack queue, separate from outbox traffic and the lossy event journal. Monotonic per-process reports carry at most eight included IDs and eight unconfirmed IDs per frame; no arbitrary metadata mutation is accepted. Local facts are coalesced until queue credit is available. They never resend peer payloads or alter the sender's handoff receipt contract. Native framing, heartbeat/epoch fencing, wake hints/watchdogs and process-owned handle cleanup follow the [messaging contract](agent-messaging.md).

## Validation

- `server/agent-inbox.test.js`: pure observer/store contracts, request failure/abort/filtering, exact identity/payload matching, capacity, lifecycle isolation, actual SHM observations and read-only HTTP/privacy checks.
- `scripts/tests/pi-inbox-smoke.mjs`: real isolated Pi with production messaging hooks and an in-process fake provider; no network or external model calls. Exercises delivery versus inclusion, failure/abort/filtering, nextTurn/followUp, explicit wake and reload/new-session uncertainty.
- `scripts/tests/agent-inbox-browser.mjs`: part of the disposable Card views browser fixture; tests literal text, read-only controls, scrolling, focus, live count changes, process boundaries and popover geometry in docked/zoomed/maximized layouts.
