# Read-only Canvas shared memory (experimental)

Scratch can publish a bounded, ephemeral Canvas projection for independent Pi processes to read without HTTP. This is an awareness layer enabled by default, not a replacement control API or database. It can be disabled explicitly. No Pi modifications, browser changes, automatic messaging or schema migration are required.

## Startup and opt-out

On macOS/Linux with Node.js, Python 3 and a C++17 toolchain:

```sh
npm ci
npm run dev  # predev builds the addon automatically
# Or: npm start  # prestart also builds it
```

Stop/start the server yourself when ready. Do not start a second server against live persistence or automatically restart existing agents. The feature is **on by default**. Set `AGENT_CANVAS_SHARED_MEMORY=0 npm run dev` (or `npm start`) for HTTP-only startup with native compilation skipped. `npm test` also builds first unless explicitly disabled; `npm run build:shm` always forces a build. Direct `node server/index.js` requires building first. A missing/unsupported native addon or failed enabled build fails startup; there is no process-local SharedArrayBuffer fallback or transparent HTTP fallback.

The addon is built for the local platform using the Node-API C interface (NAPI 8), without V8 headers or casts. Local testing covers macOS arm64 / Node 26; Linux is a target, not yet a verified CI platform. Windows is unsupported. `node-gyp` is a pinned development dependency, not a replacement for Node. The build uses matching locally installed Node headers when available, otherwise node-gyp downloads matching headers. No prebuilt native binary is committed.

When enabled, newly launched/restored Pi processes receive:

- `--extension <repo>/server/pi-canvas-memory.js`
- `AGENT_CANVAS_SHM_NAME`: unique POSIX name for this server lifetime.
- `AGENT_CANVAS_SHM_EPOCH`: expected server generation.

The extension registers `canvas_read`, `canvas_subscribe` and `canvas_unsubscribe`. Scratch also supplies a private per-process `AGENT_CANVAS_SHM_NOTIFY` semaphore name. See [subscription delivery and limits](canvas-notifications.md). Canvas also provisions dedicated writable outboxes/ack queues and loads server/pi-canvas-messages.js; its canvas_send_message/canvas_message_status tools do not grant write access to the Canvas snapshot. See [messaging protocol and process lifecycle](agent-messaging.md). Existing processes do not magically acquire a new extension or environment; they need an explicitly requested relaunch. A standalone Pi may be launched with the extension and both values supplied by its owner. There is no discovery API in this prototype.

## Tool contract

```text
canvas_read({ section?: "all"|"agents"|"edges"|"notes"|"cards"|"cardPlacements",
              offset?: integer >= 0, limit?: integer 1..100 })
```

Default: all sections, offset 0, limit 20 per section. Results include protocolVersion, serverEpoch, revision, publishedAt, source `posix-shared-memory`, and `sections`. Each section has `total`, `offset`, `items`, `nextOffset` (null at end). Results are limited to 40,000 UTF-8 bytes. Follow each section's cursor; if the combined result cannot fit, request an individual section with a smaller limit. Collections can change between calls: pagination is not a retained multi-call snapshot. Errors are explicit tool errors, not sliced/invalid JSON.

Included:

- Agent IDs, names, workspace, workdir, status/activity, progress note and saved geometry.
- Delegation edges and labels.
- Note IDs/titles/geometry and first 500 UTF-16 code units of text.
- Card IDs/types/tags/links/updatedAt and first 240 UTF-16 code units of Markdown content or Interactive title.
- Agent Canvas card placements.

Excluded by allowlist: terminal output, initial task/prompts, conversations, run tokens, session paths/IDs, environment, Interactive source/assets, card attachment data and Card Box view state. This is **not the full /api/state contract**. Changes use existing publication points: metadata is generally coalesced by 50 ms; accepted Pi activity reports publish immediately. It is the latest published snapshot, not a linearizable read of every server mutation.

The read tool never sends a prompt, triggers a model turn, modifies Canvas or injects context automatically. Notification subscriptions are separate: UI-only by default, conversation/follow-up delivery opt-in. Peer/user-authored summaries are untrusted data, not instructions. Idle does not establish success. Human gesture leases are **not** projected: read the HTTP API guide/layout endpoint before geometry mutations. All mutations, authoritative conflict/busy checks, persistence, terminal reads and full card reads remain on HTTP.

## Native implementation

`native/canvas-shm/canvas-shm.cc` is a small owned binding; `NOTICE` retains the MIT license for the shmbuf design reference. It provides:

- `create(name, capacity)`: exclusive owner creation; never opens/resizes an existing object.
- `open(name)`: read-only mapping of an existing committed object.
- `write(handle, Buffer)`: only the creator can publish.
- `read(handle)`: bounded consistent snapshot copy.
- `touch(handle)` / `invalidate(handle)`: creator heartbeat / reject stale projection.
- `close(handle)`: deterministic, idempotent local cleanup. Owner also marks closed/unlinks its generation.
- `remove(name)`: explicit cleanup of an identified orphan generation; never scan/delete unknown names.

Uses `shm_open` + `ftruncate` + `mmap(MAP_SHARED)`, **not an ordinary file-backed mapping**, and never writes runtime state into the repository or persistence files. Names are `/scsh-` plus bounded random ASCII text (under Darwin's name limit), created with mode 0600. umask can reduce permissions further. Same-user programs are not isolated. Darwin exposes mode 0 in shm fstat and does not support fchmod; the binding checks owner identity and rejects reported group/world permissions. Darwin also reports page-rounded sizes, so logical capacity is validated against—not assumed equal to—the mapped size.

Default logical payload capacity is 1 MiB; native accepted range is 4096–4194304 bytes in multiples of 8. Region sizes never change after publication. An incomplete or incompatible header is rejected before payload access. Do not reuse names or externally truncate a mapped object; a hostile same-user program can still corrupt memory or cause SIGBUS. This is not an authentication/sandbox boundary.

Shared bytes are not exposed as writable JS views. Opaque handles own mappings, and readers obtain a copied Buffer, then parse JSON. This avoids dangling JS views, V8-specific ABI conversions and accidental writes to read-only pages. It is real shared OS memory, **not zero-copy JS objects**: publication still serializes JSON, reading copies/parses it, and each tool call opens/closes its own reader. No speedup is claimed without benchmarks.

## Consistency and lifetime

The 64-byte header contains eight 64-bit fields: magic, ABI version, logical capacity, state, publication sequence, payload length, monotonic heartbeat milliseconds and owner PID. Payload is stored in aligned 64-bit words. All shared loads/stores, including payload, use sequentially consistent lock-free native atomic operations; compilation fails on targets without lock-free 64-bit atomics. The design assumes the supported OS/architecture's coherent shared mappings. It does not rely on process-private pthread locks, JS Atomics.wait/notify, futex wakeups or unprotected concurrent memcpy.

One writer marks the sequence odd, publishes length/payload, then commits an even sequence. Readers copy and accept only an unchanged even sequence with ready state. They attempt at most eight times, then return SHM_BUSY; a writer dying mid-publication cannot make readers spin forever. The heartbeat is refreshed every second independently of data revision. A heartbeat older than five monotonic seconds returns SHM_STALE, even for idle data. An event-loop stall can also produce stale: it is not proof that a process stopped.

Capacity/serialization/publication failures invalidate the old projection and log a deduplicated error, while HTTP remains usable. A later successful publication restores readiness. Graceful shutdown marks the generation closed, unlinks its name and unmaps the writer; existing readers can detect closed state. GC also cleans abandoned native handles. SIGKILL cannot run cleanup: orphan names/allocations may remain until explicit cleanup or system cleanup. Heartbeat expiry prevents serving that old data indefinitely; no automatic stale-object deletion is attempted.

A new server gets a new name and epoch. Old readers do not silently follow it. There is no automatic reconnect, server election, mailbox, message acknowledgment, persistent memory or multi-writer operation. Session subscriptions use a 256-record ordered SHM journal, native named-semaphore wakeups and a dedicated receiver thread per subscribed Pi process; see [notifications](canvas-notifications.md). There is no canvas_wait tool.

## Validation

```sh
npm run test:shm     # builds + native/HTTP/extension unit and integration tests
npm run test:shm:pi  # requires installed pi CLI; isolated real Pi, no LLM call
npm test
npm run test:views:browser
npm run build
```

`npm test` builds the addon by default. When `AGENT_CANVAS_SHARED_MEMORY=0` skips compilation and no addon exists, native tests are explicitly skipped; use test:shm to require compilation and run them. Run native builds and their tests sequentially, not concurrently, because a rebuild temporarily removes the binary. Tests use unique fixture-owned shm objects and fake PTYs; the real-Pi driver uses a temporary agent directory, --no-session, no auto-discovered extensions, a diagnostic slash command and HTTP forbidden during the memory read. It checks production tool registration, invokes the read implementation, and receives an idle event through the native subscription controller, not a paid model-generated tool call. No live Canvas/persistence/agents are used. Python is used by a test-only corruption helper to verify incomplete initialization, invalid versions, interrupted sequence and invalid length handling.
