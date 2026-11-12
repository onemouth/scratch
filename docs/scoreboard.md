# Agent Board

The **Board** header button opens a top-centered quick-view panel in Agent Canvas or Card box. It lists only running Agent Canvas processes, including idle ones; Card box, stopping and stopped processes are excluded. A newly started process with no activity report displays `running`; reported turn states display `working` or `idle`. No percentage, completion inference or task-success claim is added.

Each row shows Agent name, status and progress. Progress is a single ellipsized line with the full original string in the native hover tooltip, matching the former node progress treatment. Missing progress is an empty string. All names/progress render as text, not HTML. Inline progress was removed from both Canvas and Card box Agent windows. Card box telemetry still exists for SHM awareness but is not shown in this panel.

## Data and lifecycle

- Pi continues to use `canvas_set_progress` and existing process-scoped POSIX SHM telemetry. No new reporting tool, HTTP writer, fallback or retry is introduced.
- Scratch validates/applies reports and owns authoritative process metadata. `shared/scoreboard.js` produces a safe projection for both the POSIX SHM snapshot's `scoreboard` array and existing browser SSE/state snapshots. Browsers receive the projection through the existing application transport, not direct memory mapping. No new polling or independent database is added.
- Rows contain only `id`, `name`, `generation`, `status`, `progress`, and `updatedAt`. Source Agent summaries also expose `scoreboardUpdatedAt`; existing `canvas_read` pagination stays unchanged. No prompts, session paths, terminal output or capabilities enter scoreboard rows.
- `updatedAt` uses process-local logical milliseconds: `max(Date.now(), previous + 1)`. Startup, an accepted progress report (even identical text), or an actual activity-state change advances it. Session reports, repeated identical activity, renames, geometry changes and unrelated snapshots do not. Descending timestamp order has an Agent-ID tie-breaker.
- Idle retains the last progress. A replacement process clears it before publishing; a reload/new/resume/fork inside the same Pi process does not. Existing generation and sequence checks still reject old-process reports. Sort metadata is ephemeral, not persisted. Existing progress persistence remains unchanged, but restored processes clear their previous note on startup.
- On browser transport failure the panel identifies disconnection and disables navigation rather than claiming stale rows are live.

## Interaction

The panel is portaled to the document body so the header's backdrop filter cannot change its viewport positioning. It stays horizontally centered, 48 CSS pixels from the viewport top, with viewport-bounded width/height and scrolling for long lists.

Outside pointer press, Escape, the close button or row activation closes the panel. Escape/close restores focus to its trigger. Opening focuses the nonmodal dialog; native buttons provide keyboard navigation. Escape is intercepted before terminal input.

Row activation switches to Agent Canvas, closes the panel and reuses Agent focus/navigation without maximizing. Navigation waits for workspace viewport restoration before centering the node, so a prior Card box viewport cannot overwrite the requested location. Missing/stopped targets are rechecked before navigation. Neither the trigger nor panel exists while any Agent/card is maximized; there is no floating entry. Terminal instances and sockets are not remounted by this feature.

## Validation

- `shared/scoreboard.test.js`: filtering, safe projection, empty progress and stable timestamp/ID ordering.
- `server/scoreboard.test.js`: isolated fake PTYs with real POSIX SHM telemetry and snapshot reads; timestamp transitions, idle retention, session handoffs, unchanged reports, restart clearing and stale-generation fencing.
- `scripts/tests/scoreboard-browser.mjs`, included in `npm run test:views:browser`: both workspaces, sorting, literal long text/tooltips, outside/Escape dismissal, navigation/focus, restart/filtering, maximization, narrow viewport and terminal continuity. The fixture never touches live Canvas data or runs a model.
