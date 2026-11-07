# Canvas subscriptions and notifications

Pi agents no longer need to block on a wait request to learn about another agent. The default-on shared-memory extension provides `canvas_read`, `canvas_subscribe` and `canvas_unsubscribe`. There is **no canvas_wait tool**. The former HTTP wait endpoint has been removed and returns 404; subscription notifications replace that workflow, not mutation/terminal APIs. HTTP-only clients have no blocking wait fallback.

## Subscribe, return immediately, continue working

```js
canvas_subscribe({ agentId: "<existing agent id>" })
// Defaults: events [idle, stopped, removed], delivery notification, wake false,
// once false. Returns subscriptionId, cursor, serverEpoch, scope and active.

canvas_subscribe({
  agentId: "<existing agent id>",
  events: ["idle"],
  delivery: "nextTurn",
  once: true
})

// Explicit, one-shot follow-up, including permission to start an idle model:
canvas_subscribe({
  agentId: "<existing agent id>",
  events: ["idle"],
  delivery: "followUp",
  once: true,
  wake: true
})

canvas_unsubscribe({ subscriptionId: "<returned id>" })
canvas_unsubscribe({ subscriptionId: "*" }) // this Pi session only
```

Events: `started`, `working`, `idle`, `stopped`, `removed`, `progress`. This first notification phase covers **Agent lifecycle/activity/progress notes**, not arbitrary card/note/layout events. Only future events after registration are delivered: subscribing to an already-idle agent does not fabricate a completion event. Use canvas_read for current state. An idle event is not proof of task success. `initial:true` marks an activity transition from unknown (for example an initial startup report), not completed work.

The target must exist at subscription time. By default subscriptions follow the logical agent ID across stop/resume, explicitly reported as scope `agent-id-across-restarts`; each event includes a public process generation when available. Optional `generation` filters for exact equality, reported as scope `process-generation`. This is not the secret session/activity callback run token. A new **server epoch** is never silently followed.

Delivery modes:

- `notification` (default): TUI/RPC UI notification only, **no conversation message and no LLM call**. Requires a UI-capable Pi context.
- `nextTurn`: custom message queued for the next user prompt, no automatic model wake.
- `followUp`: custom follow-up queued through Pi; while busy this can cause another model continuation, even with wake false. With wake true it can also start an idle agent. It requires `once:true`, and self-targeted follow-ups are rejected to reduce automatic feedback loops. Wake is rejected with other delivery modes.

Do not subscribe agents to automatically wake each other in a cycle. Prefer UI-only or nextTurn delivery. Peer names/progress are untrusted data, not instructions, and custom messages identify their source rather than impersonating human input. A result with `active:false` can mean a once-only event was already delivered during registration.

Subscriptions are bounded to 32 per Pi session, not persisted, and are closed on unsubscribe/session shutdown/reload/replacement. Restarting a Pi does not replay subscription work. Abort of the subscribe tool cancels registration before it starts, not an already-established subscription; use unsubscribe afterwards. No polling/wait tool blocks an LLM call.

## SHM facts, semaphore wakeups

1. Scratch observes runtime changes synchronously, including process exit before automatic replacement, activity reports and metadata mutation broadcasts.
2. It appends ordered records to a bounded **256-event SHM journal**, with sequence, agent ID, public generation, type and observed status/activity. Progress events include the bounded progress note.
3. It publishes the journal immediately, bypassing browser snapshot coalescing.
4. It calls sem_post on each Pi process's private notification semaphore. Notification counts carry no event payload and can be coalesced.
5. A dedicated native receiver thread in Pi blocks on sem_wait, then schedules a bounded Node-API thread-safe callback. The extension reads the SHM journal and dispatches matching future records.

Each launched/restored Pi gets a fresh `AGENT_CANVAS_SHM_NOTIFY` name, created by Scratch before launch. There is one channel per Pi process, not a shared semaphore that would distribute wakeups to competing agents. The binding rejects duplicate receivers for one channel in the same process (including worker environments). Do not give the same channel to a second independent Pi process. The receiver owns no writer capability for snapshots/events.

Native receive threads are separate from the Node event loop and the libuv shared worker pool. The callback queue holds at most one hint; the journal preserves distinct transitions such as working→idle→working. Registration records a cursor, arms the receiver, then rechecks to avoid lost wakeups. Unsubscribe wakes/joins the receiver when the last subscription ends; environment cleanup also stops native threads. Callbacks and watchdog timers do not keep an otherwise-finished process alive.

A once-per-second watchdog checks SHM liveness and can drain a missed hint; it is not repeated HTTP polling. It detects a crashed/stalled publisher even when no semaphore wakeup arrives. SHM_BUSY retries on a later callback/watchdog. Other snapshot/channel failures stop affected subscriptions explicitly; UI sessions receive a warning, non-UI sessions get a nextTurn error message without an automatic wake.

If the cursor falls behind overwritten journal entries, return/report `SHM_EVENTS_LOST`; never silently invent the missing outcome. At most 64 matching deliveries are dispatched per drain; exceeding that stops subscriptions with `SHM_NOTIFICATION_LIMIT`. Read current state and explicitly resubscribe. These are bounded, in-memory, best-effort session notifications, **not durable messages, exactly-once processing, task acknowledgments or task resumption**.

The existing 1 MiB snapshot capacity includes the journal; capacity/serialization failure still invalidates the projection instead of exposing stale state. Graceful server/Pi exits close/unlink owned channels. SIGKILL can leave named semaphore/shared-memory orphans until explicit cleanup; native signalRemove(name) removes an identified orphan semaphore, and remove(name) removes an identified orphan SHM name. Never scan/remove unknown or active sessions' objects. Same-user programs are not security-isolated. macOS arm64 is exercised locally; Linux remains a target requiring platform validation.

## Tests

- `server/canvas-notify.test.js`: registration race, ordered fast transitions, once/cancel, filters, bounded subscriptions, explicit journal gaps, delivery policy, two independent receiver processes, native cleanup and libuv availability.
- `npm run test:shm`: builds and requires all native snapshot/notification tests.
- `npm run test:shm:pi`: isolated real Pi registers the production tools, reads SHM with HTTP forbidden, then receives a real semaphore-triggered idle event through a diagnostic command; no LLM call, saved session, live Canvas or persistence mutation.

Rebuilds and tests must run sequentially; do not rebuild the native binary while new processes are trying to load it. Existing live processes do not hot-acquire notification tools/channels. Do not restart other agents or services automatically.
