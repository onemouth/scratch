# Pi → Scratch SHM telemetry

Telemetry is a dedicated process-scoped channel for Pi's own activity, current session identity and progress note. It does not share queues, semaphore names, receipt credits or model-wake budgets with peer messaging. Scratch remains the sole Canvas snapshot writer, validation/application authority and persistence owner. This is not a generic mutation RPC.

## Transport and ownership

Scratch always provisions two claimed SPSC POSIX queues per Pi process: reports (16 × 16384-byte slots; Pi produces, Scratch consumes) and receipts (16 × 1024-byte slots; Scratch produces, Pi consumes). Two private named semaphores provide wake hints. Queue truth is independent of hints; both sides have a one-second watchdog. Native handles expose copies, not mapped JS pointers. This reuses the native queue implementation, not the peer-message protocol or its traffic queues. Approximate queue mapping cost is 272 KiB per process plus headers/page rounding and semaphore/thread resources; at most 256 telemetry channels/server.

Scratch supplies private `AGENT_CANVAS_SHM_TELEMETRY` descriptors to new/restored Pi processes. `server/pi-session-tracker.js` binds the transport on session_start, never during extension-factory discovery. A broker on the Pi process retains queues, sequences and receipt history across reload/new/resume/fork, and replaces its context binding. Old handlers/tools cannot publish through a replacement binding; stale shutdown handlers cannot close it. Pi retains its native handles until process quit/exit (or failed initialization). Ordinary session replacement and temporary snapshot failures never close them; fatal generation/protocol errors fence operations without releasing the process-owned handles. Scratch still closes its owned endpoints on process exit/server shutdown and fences unsafe application failures. No automatic reconnect/relaunch or restart replay; heartbeat recovery keeps the original handles and generation (see below).

Session/activity/progress use only SHM, with channel-inferred identity/generation and strictly increasing process-wide sequences across all report kinds. No telemetry path falls back or automatically resends an uncertain report.

Existing live processes cannot acquire new environment/descriptors automatically. The user must choose when to restart the service/processes; never do this automatically.

## Reports and receipts

The report envelope is `{version:1,seq,kind,data,expiresAt}`. Scratch infers agent ID and process generation from the provisioned channel, validates against the current runtime and rejects injected identity/extra fields. Sequence numbers are positive safe integers, strictly increasing per channel across all kinds (not required to be contiguous); duplicates/older reports are not reapplied. Each report expires ten seconds after publication.

- `activity`: `{state:"working"|"idle",summary?:string}`. The optional nonblank summary is idle-only, at most 240 JS UTF-16 code units. The Unicode-safe assistant preview uses the agent_settled hook; intermediate working/idle transitions synchronously publish their notification journal entries. Activity/preview are transient, never persisted.
- `session`: `{sessionFile:absolutePath|null,sessionId:string}`. File path max 4096 code units, nonblank ID max 100. These remain private session metadata, not awareness-snapshot fields. Session reports update exact-session restore metadata via Scratch's metadata persistence path.
- `progress`: `{text:string}`. Maximum 500 code units; empty clears the note. Only the channel owner's note can be updated. No name/layout/other-agent fields are accepted. Progress is included in public Canvas summaries and saved via the metadata persistence path; do not put secrets in it.

Publication returns `{seq,status:"queued",kind}`. Queued proves only queue publication. Scratch emits one terminal receipt `{seq,status:"applied"|"rejected",code?,at}`. Applied proves server validation/application completed, **not durable disk flush**. Metadata uses the debounced save and shutdown flush. Validation/deadline/sequence failures are rejected. If application may have partially committed or receipt publication fails, the channel is fenced: the client treats pending reports as unknown, never rejected/safe to resend.

The client tracks at most 16 outstanding reports and the latest 64 statuses. Queue/window exhaustion fails before publication; it never overwrites records. A post-publication semaphore failure preserves the queued sequence with `notificationWarning`. Missing acknowledgment at the deadline becomes unknown; later actual receipts can refine evidence, without resend. Lost/closed/incompatible channels fence operations but retain Pi's process-owned handles. `SHM_STALE`, `SHM_BUSY`, `SHM_NOT_READY` and `SHM_UNAVAILABLE` pause operations until the original publisher has a valid snapshot again. Rejected/unknown outcomes and transport failures update the shared Canvas footer status, never insert transport notifications into the conversation or wake an LLM. This is cooperative bounded sequence fencing, not an exactly-once or durability guarantee. A stalled or full channel can lose later telemetry reports; a paused/error status means Canvas status/restore metadata may be outdated.

Representative codes: `TELEMETRY_ARGUMENT`, `TELEMETRY_EXPIRED`, `TELEMETRY_SEQUENCE`, `TELEMETRY_LIMIT`, `TELEMETRY_GENERATION`, `TELEMETRY_ACK_TIMEOUT`, `TELEMETRY_CHANNEL_CLOSED`, `TELEMETRY_CHANNEL_FENCED`, `TELEMETRY_HISTORY_MISSING`, plus native SHM errors. Same-user filesystem permissions and provisioned channels are not an authentication/sandbox boundary.

## Sleep / heartbeat recovery

A heartbeat older than five seconds can mean sleep or an event-loop stall, not a dead server. On temporary snapshot failures (including `SHM_STALE`), the client keeps its original queues, sequence and receipt history, pauses writes/receipt draining, and marks unresolved published reports unknown. New progress/activity/session sends fail before publication while paused; they are not buffered for replay. The one-second watchdog keeps checking only the original snapshot name and epoch, with no HTTP fallback or new channel claims.

Once the same epoch has a valid heartbeat again, receipt draining resumes; actual receipts can refine earlier unknown outcomes. The broker samples **current** session identity and working/idle state from its current context and publishes fresh reports with new sequences. It does not resend cached reports, old progress or notification previews. If backpressured, it waits for two report credits and samples again when space is available. While detached, it never samples the old context; the next session_start reports its own fresh state. Telemetry and messaging share one Pi footer entry via `ui.setStatus()`: temporary failures show `Canvas paused`, fatal/configuration errors retain their channel/error codes, and the entry clears only when neither channel has a problem. Ordinary sleep/stale/recovery cycles produce no `ui.notify()` messages; no OS sleep detection or heartbeat relaxation is used. Detachment removes the old UI binding, and replacement sessions render the current broker state. Recovery never wakes a model; failed tool operations still return their original errors. Receipt warnings clear after a newer report is confirmed applied, without altering the older report's recorded outcome. Initial startup during heartbeat expiry follows the same pause/recovery path.

Closed/missing publishers, epoch mismatches and incompatible/corrupt channels still fence the transport; the client never follows a replacement service instance. Extension reload retains the existing process-owned broker and transport callbacks; callback-code changes require an explicit user-managed Pi process relaunch, not just `/reload`. Peer messaging also pauses/recovers on temporary snapshot failures; session-scoped subscriptions have explicit gap/error semantics.

## Agent tool

```text
canvas_set_progress({text:"Reviewing SHM queue synchronization"})
```

Registered for Canvas-launched Pi processes. It enqueues the calling process's own progress note and returns queued, not saved/applied. Use canvas_read for an observed summary when needed, not a polling loop. Do not resend uncertain outcomes or switch to HTTP after a failed SHM send. Session/activity reporting is automatic; do not write native queues directly. Name/geometry, lifecycle and card/view operations use the HTTP API; human leases and browser SSE/terminal WebSocket are separate interfaces.

## Validation

- `server/canvas-telemetry.test.js`: actual POSIX queues, strict fields/inferred identity, receipts, expiry/duplicates, bounded history/backpressure, lost hints, timeout/late evidence, stale epochs, actual native heartbeat expiry/recovery (including initial stale startup, full-window backpressure and detached/current-context refresh), fatal closed/corrupt generation fencing, uncertain post-commit failure, process-context replacement and independent peer delivery while telemetry is full. Production runtime tests cover session/activity/progress application, generation fencing, transport/operation boundary checks, metadata persistence and graceful close.
- `server/pi-session-tracker.test.js`: preview behavior, missing/broken SHM configuration without HTTP requests, and atomic rejection of unsupported progress writes.
- `npm run test:shm:pi`: two isolated real Pi processes use production peer and telemetry extensions with HTTP forbidden and no LLM call. Actual reload/new/resume/fork exercises messages queued during handoff, current session identity reports, monotonically increasing telemetry sequences, the production progress tool and retained receipts. Only owned disposable session fixtures are created/removed; no live Canvas/user data is touched.

macOS arm64 verified; Linux remains unverified.
