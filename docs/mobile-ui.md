# Mobile UI

At layout viewport widths below **768 CSS pixels**, Scratch automatically shows the mobile interface. Wider layouts use the existing desktop interface. There is no manual mode switch, user-agent detection or change to network exposure; existing Tailscale access is unchanged. Width, not keyboard height, chooses the interface.

## Board and Agent terminal

- Board is the mobile home screen, using the existing authoritative Board projection. Running Agent Canvas processes, including idle ones, are listed newest progress/status change first. Card box processes are excluded. Progress is literal text, up to three lines.
- Tap an Agent to open one real xterm terminal. Back returns to the retained Board list. Switching bottom tabs closes the detail view and its browser terminal subscription, not the Agent process.
- Monitoring is the default. The terminal textarea is read-only, does not auto-focus or summon a keyboard, and terminal input is gated both in the client and on its mobile WebSocket connection.
- **Input** explicitly enables typing. **Monitor** disables it and blurs the textarea. Esc, Tab, Ctrl+C and Enter buttons assist terminal interaction. Paste uses existing chunking and does not replay on reconnect.
- Scrollback is xterm's bounded buffer, not a full conversation transcript. The existing bounded ANSI replay is retained; no new transcript or history store is introduced. Scroll away from the bottom without forced follow; **Latest** returns to current output.
- Disconnection disables input. Reconnection starts in monitoring mode and requires fresh opt-in. Offline browser events also disable input and suspend the mobile event stream; online opens a fresh stream. Data is labeled potentially outdated until a snapshot arrives.
- Each mobile subscription is pinned to the selected process generation. Process end closes it; a new generation mounts a new monitoring terminal, never inheriting input permission.

## Shared PTY size

A mobile terminal never sends `resize`, even in Input mode, on orientation changes or keyboard resize. It renders the existing PTY columns/rows and allows horizontal scrolling rather than changing the desktop's layout. Desktop sizing behavior is unchanged.

`/api/terminal/:id?mobile=1&generation=<generation>` opts into the observer protocol. The server rejects stale/missing generations. Binary JSON `{type:"size",cols,rows}` frames precede ANSI replay and notify observers after accepted desktop resizes. Text frames remain ordinary ANSI output. Desktop subscribers receive no binary control frames. Initial dimensions come from the current PTY (or its 50×16 spawn defaults); accepted sizes are process-local and are not persisted in Canvas geometry.

Mobile input starts disabled on each socket and requires `{type:"input-mode",enabled:true}`. Disabling resets this flag; mobile resize messages are ignored. Input additionally checks the original child identity and generation. Runtime closes mobile sockets with code 4001 on process end/replacement. Desktop sockets retain their existing lifecycle behavior.

These flags are interaction safety, **not authentication or a new permission boundary**. The terminal can perform writes once input is enabled.

## Read-only Cards

Cards supports existing Views, local OR-word search, NFKC/case-normalized exact tag filters, pagination, Markdown/KaTeX, existing image/audio attachments, linked cards and sandboxed Interactive Play.

The mobile reader is composed from display/playback components only: no editable draft restoration, autosaver, uploader, membership controls, shared View activation, content CRUD or geometry/viewport writers. Changing View/search/tag is local to that browser and never changes the desktop's shared current View. Deleted Views produce an unavailable/empty selection rather than silently broadening the query. Deleted cards show an unavailable message.

Interactive Play reuses the existing sandbox, source/asset GETs, revision fencing and explicit Play trust boundary. It does not expose editing or saving. Local sandbox interaction can change the running presentation, not the stored card.

This is a **mobile UI read-only policy**, not server-side read-only authorization. Existing APIs and enabled terminal commands retain their normal capabilities.

## Responsive lifecycle and validation

Only one interface mounts at once, avoiding hidden desktop terminals and resize writers. Mobile UI never changes Canvas geometry, Card box placement or saved viewport. Crossing the breakpoint cleans up event streams, terminal subscriptions and listeners without stopping/restarting an Agent or replaying commands. Desktop's normal sizing/persistence resumes when the desktop interface mounts; pre-existing desktop drafts retain their existing save behavior.

The app uses `visualViewport` height/offset and safe-area insets for the keyboard and device chrome. Text remains selectable. Search inputs use 16px text to avoid common iOS focus zoom.

Automated checks:
- `src/mobile-state.test.js`: pure local View/search/tag projections and excluded Card box Agent.
- `server/mobile-terminal.test.js`: real WebSockets, dimensions, ANSI replay, explicit input opt-in, ignored mobile resizing, desktop compatibility and generation fencing.
- `scripts/tests/mobile-browser.mjs`: disposable Chrome, fake PTYs and database; automatic UI, monitor/input, Chinese text insertion, keys, viewport changes, local read-only Cards/math/Play, no HTTP mutations or geometry/View changes, process replacement, offline recovery and desktop restoration. Included in `npm run test:views:browser`; `CANVAS_MOBILE_ONLY=1 npm run test:views:browser` runs just mobile integration.

Actual iOS/Android keyboard composition, touch scrolling/selection, browser chrome and Tailscale use still need human device validation. Desktop Chrome emulation and Chinese text insertion are not proof of native IME/device behavior. No live service or Agent is restarted by the fixture.
