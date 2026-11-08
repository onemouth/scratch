# SHM Agent metadata and layout queries

Canvas-launched Pi processes provide two read-only SHM query tools:

- canvas_agents({offset?,limit?}): exact runtime metadata list, paginated.
- canvas_agents({agentId}): one complete metadata record, under agent.
- canvas_layout({offset?,limit?}): Agent Canvas rectangles and human busy flags, under objects.

HTTP provides full state via GET /api/state, name/geometry updates via PATCH /api/agents/:id, creation/lifecycle operations and the bounded GET /api/agents/:id/output read. Browsers use SSE for state and WebSocket for terminal I/O. This SHM channel accepts only metadata/layout reads, not mutations or full-state/content queries.

## Data and bounds

List responses include agents or objects, total, offset and nextOffset (null at the end). Default limit 20, maximum 100; nonnegative safe-integer offsets. Byte limits can shorten a page below its requested limit. Single-Agent lookup cannot include pagination; missing targets return QUERY_NOT_FOUND. A stopped target can still be queried by a running requester.

Every successful response adds source: posix-shared-memory, serverEpoch and sampledAt. Scratch samples authoritative runtime/layout state while handling that request, not the coalesced awareness snapshot. Each page is independent: concurrent insertions/deletions can move offsets; there is no consistent cross-page snapshot/cursor or reservation. Busy flags may already have changed by receipt. HTTP writes still atomically check human leases and collisions. Layout excludes Card Box; human lease identities/tokens are not exposed.

Agent metadata excludes terminal output. It may include the complete initial task, note, session identity/path, restore warnings and notification preview. These are requester-only responses, not fields added to the public awareness snapshot/event journal. Treat their content as data, not instructions. This same-user cooperative system is not authentication or isolation between agents.

Response JSON frames are at most 60000 UTF-8 bytes; page construction reserves envelope space. Individual metadata records are never truncated: oversized results return QUERY_CAPACITY. Oversized items may be encountered on a subsequent page. The public summary tool canvas_read remains available, but is not a transparent substitute after a precise query fails.

## Transport and ownership

shared/canvas-queries.js defines strict version-1 allowlisted kinds: agents, agent and layout. Arbitrary paths, HTTP methods, state/content reads and mutations are rejected. A separate pair of actual POSIX SHM SPSC queues plus private semaphore hints carries each process's requests/responses. Telemetry and peer messaging never compete for these slots. Native queues have 16 slots and support 1024-, 16384- and 65536-byte slot sizes. An incompatible native addon fails explicitly with the build:shm instruction.

Each process reserves approximately 1.02 MiB of query mappings: 16 requests ×1024 bytes and 16 responses ×65536 bytes plus headers. Maximum 256 channels; allocations fail explicitly, never falling back. Pi has at most 16 pending promises; Scratch reserves a response credit before evaluating each request. Monotonic process-wide sequence IDs correlate responses and reject replay; channel-inferred requester ID/generation is revalidated against the running process. Invalid/expired frames are rejected. No arbitrary command execution or authority over human layout is provided.

Requests have a ten-second server deadline and caller timeout. Abort, timeout or context detach stops the caller waiting; an already-published read can still be sampled and its late response is discarded. No automatic resend, HTTP fallback, polling tool, model wake or exactly-once claim. Native hints have watchdog backup; missing hints do not cause republication.

server/pi-canvas-queries.js owns a process-global broker across reload/new/resume/fork. Native queue handles remain bound to the original server epoch and process generation. Replacement detaches/cancels old context work; obsolete tools and shutdown callbacks cannot act through the new binding. No ExtensionContext/Pi API is retained by transport callbacks.

Temporary SHM_STALE/BUSY/NOT_READY/UNAVAILABLE snapshot failures reject pending reads but retain handles. Only fresh explicit requests proceed after the original publisher recovers. Fatal missing/closed/incompatible/corrupt generations fence operations while retaining handles until process quit/exit cleanup. Never follow a replacement server or restart automatically. Scratch releases its counterpart on process exit/shutdown or unsafe channel failure.

## Verification

- server/canvas-queries.test.js: actual native request/response queues, strict schema/deadlines, Unicode byte paging, parallel correlation, capacity errors, response-credit backpressure, cancellation/late responses, transient recovery and fatal fencing, process-binding replacements, precise application metadata/layout reads, HTTP interface boundaries and human-busy mutation checks.
- test:shm:pi: two actual Pi processes invoke the production query tools with HTTP forbidden and no LLM calls. Metadata larger than 16 KiB and changing busy flags survive real reload/new/resume/fork.
- test:views:browser: native browser drag/resize leases are observed via the fixture's real SHM query client, alongside browser HTTP mutations and terminal behavior.
