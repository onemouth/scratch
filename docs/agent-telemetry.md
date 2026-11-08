# Pi → Scratch SHM telemetry

Telemetry is a dedicated process-scoped channel for Pi's own activity, current session identity and progress note. It does not share queues, semaphore names, receipt credits or model-wake budgets with peer messaging. Scratch remains the sole Canvas snapshot writer, validation/application authority and persistence owner. This is not a generic mutation RPC.

## Transport and ownership

With SHM enabled (the default), Scratch provisions two claimed SPSC POSIX queues per Pi process: reports (16 × 16384-byte slots; Pi produces, Scratch consumes) and receipts (16 × 1024-byte slots; Scratch produces, Pi consumes). Two private named semaphores provide wake hints. Queue truth is independent of hints; both sides have a one-second watchdog. Native handles expose copies, not mapped JS pointers. This reuses the native queue implementation, not the peer-message protocol or its traffic queues. Approximate queue mapping cost is 272 KiB per process plus headers/page rounding and semaphore/thread resources; at most 256 telemetry channels/server.

Scratch supplies `AGENT_CANVAS_TELEMETRY_TRANSPORT=shm` and private `AGENT_CANVAS_SHM_TELEMETRY` descriptors to new/restored Pi processes. `server/pi-session-tracker.js` binds the transport on session_start, never during extension-factory discovery. A broker on the Pi process retains queues, sequences and receipt history across reload/new/resume/fork, and replaces its context binding. Old handlers/tools cannot publish through a replacement binding; stale shutdown handlers cannot close it. Transport closes on process quit/exit, fatal channel failure or Scratch shutdown, not ordinary session replacement or temporary heartbeat expiry. No automatic reconnect/relaunch or restart replay; heartbeat recovery keeps the original handles and generation (see below).

`AGENT_CANVAS_SHARED_MEMORY=0` selects HTTP-only composition, skips native provisioning/build and explicitly launches Pi with `AGENT_CANVAS_TELEMETRY_TRANSPORT=http`. Session/activity then use the existing internal HTTP callbacks. Their process-scoped sequence counter also survives runtime replacement; older sequenced session reports cannot overwrite newer ones. Once a sequenced session report is received, unsequenced replacements are rejected. HTTP-only progress uses the existing agent PATCH API, not the SHM-only tool. SHM failures never fall back to HTTP; mixing HTTP session/activity reports into a provisioned SHM run returns 409. No telemetry path automatically resends an uncertain report.

Existing live processes cannot acquire new environment/descriptors automatically. The user must choose when to restart the service/processes; never do this automatically.

## Reports and receipts

The report envelope is `{version:1,seq,kind,data,expiresAt}`. Scratch infers agent ID and process generation from the provisioned channel, validates against the current runtime and rejects injected identity/extra fields. Sequence numbers are positive safe integers, strictly increasing per channel across all kinds (not required to be contiguous); duplicates/older reports are not reapplied. Each report expires ten seconds after publication.

- `activity`: `{state:"working"|"idle",summary?:string}`. The optional nonblank summary is idle-only, at most 240 JS UTF-16 code units. The existing Unicode-safe assistant preview and agent_settled hook remain; intermediate working/idle transitions synchronously publish their notification journal entries. Activity/preview are transient, never persisted.
- `session`: `{sessionFile:absolutePath|null,sessionId:string}`. File path max 4096 code units, nonblank ID max 100. These remain private session metadata, not awareness-snapshot fields. Session reports update exact-session restore metadata via Scratch's existing persistence path.
- `progress`: `{text:string}`. Maximum 500 code units; empty clears the note. Only the channel owner's note can be updated. No name/layout/other-agent fields are accepted. Progress is included in public Canvas summaries and saved via the existing metadata path; do not put secrets in it.

Publication returns `{seq,status:"queued",kind}`. Queued proves only queue publication. Scratch emits one terminal receipt `{seq,status:"applied"|"rejected",code?,at}`. Applied proves server validation/application completed, **not durable disk flush**. Metadata uses the existing debounced save and shutdown flush. Validation/deadline/sequence failures are rejected. If application may have partially committed or receipt publication fails, the channel is fenced: the client treats pending reports as unknown, never rejected/safe to resend.

The client tracks at most 16 outstanding reports and the latest 64 statuses. Queue/window exhaustion fails before publication; it never overwrites records. A post-publication semaphore failure preserves the queued sequence with `notificationWarning`. Missing acknowledgment at the deadline becomes unknown; later actual receipts can refine evidence, without resend. Lost/closed/incompatible channels are fatal failures; `SHM_STALE` is a recoverable pause, not a closed channel. Rejected/unknown outcomes and transport failures produce bounded/deduplicated UI warnings, never LLM turns. This is cooperative bounded sequence fencing, not an exactly-once or durability guarantee. A stalled or full channel can lose later telemetry reports; warnings mean Canvas status/restore metadata may be outdated.

Representative codes: `TELEMETRY_ARGUMENT`, `TELEMETRY_EXPIRED`, `TELEMETRY_SEQUENCE`, `TELEMETRY_LIMIT`, `TELEMETRY_GENERATION`, `TELEMETRY_ACK_TIMEOUT`, `TELEMETRY_CHANNEL_CLOSED`, `TELEMETRY_HISTORY_MISSING`, plus native SHM errors. Same-user filesystem permissions and provisioned channels are not an authentication/sandbox boundary.

## Sleep / heartbeat recovery

A heartbeat older than five seconds can mean sleep or an event-loop stall, not a dead server. On `SHM_STALE`, the client keeps its original queues, sequence and receipt history, pauses writes/receipt draining, and marks unresolved published reports unknown. New progress/activity/session sends fail before publication while paused; they are not buffered for replay. The one-second watchdog keeps checking only the original snapshot name and epoch, with no HTTP fallback or new channel claims.

Once the same epoch has a valid heartbeat again, receipt draining resumes; actual receipts can refine earlier unknown outcomes. The broker samples **current** session identity and working/idle state from its current context and publishes fresh reports with new sequences. It does not resend cached reports, old progress or notification previews. If backpressured, it waits for two report credits and samples again when space is available. While detached, it never samples the old context; the next session_start reports its own fresh state. Recovery is UI-only and never wakes a model. Initial startup during heartbeat expiry follows the same pause/recovery path.

Closed/missing publishers, epoch mismatches and incompatible/corrupt channels still fence the transport; the client never follows a replacement service instance. This recovery policy is specific to telemetry, not a change to peer messaging or subscription failure semantics. A process already running the old, permanently-closing implementation needs one user-chosen process restart to load this fix; extension reload does not replace its process-owned broker.

## Agent tool

```text
canvas_set_progress({text:"Reviewing SHM queue synchronization"})
```

Registered only for SHM mode. It enqueues the calling process's own progress note and returns queued, not saved/applied. Use canvas_read for an observed summary when needed, not a polling loop. Do not resend uncertain outcomes or switch to HTTP after a failed SHM send. Session/activity reporting is automatic; do not call the internal callbacks or write native queues directly. Layout, lifecycle, cards/views/media, authoritative human leases and browser SSE/terminal WebSocket remain unchanged on their existing interfaces.

## Validation

- `server/canvas-telemetry.test.js`: actual POSIX queues, strict fields/inferred identity, receipts, expiry/duplicates, bounded history/backpressure, lost hints, timeout/late evidence, stale epochs, actual native heartbeat expiry/recovery (including initial stale startup, full-window backpressure and detached/current-context refresh), fatal closed/corrupt generation fencing, uncertain post-commit failure, process-context replacement and independent peer delivery while telemetry is full. Production runtime tests cover session/activity/progress application, generation fencing, HTTP-mixing rejection, metadata persistence and graceful close.
- `server/pi-session-tracker.test.js`: preview behavior and explicit HTTP-only process-sequence continuity/stale-context cleanup. HTTP query tests cover late older session reports.
- `npm run test:shm:pi`: two isolated real Pi processes use production peer and telemetry extensions with HTTP forbidden and no LLM call. Actual reload/new/resume/fork exercises messages queued during handoff, current session identity reports, monotonically increasing telemetry sequences, the production progress tool and retained receipts. Only owned disposable session fixtures are created/removed; no live Canvas/user data is touched.

No Canvas JSON or card SQLite schema migration; no Pi modification or browser transport change. macOS arm64 verified; Linux remains unverified.
