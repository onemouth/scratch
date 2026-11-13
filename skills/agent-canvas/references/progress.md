# Update your progress note

## When to report

Progress is an active part of substantive work in a Canvas-launched process, not just a tool to use when asked. For multi-step investigation, implementation, testing or delegated work:

- Start with a short description of the task you are actually beginning.
- Update when the work moves to a meaningful new phase, such as investigation → implementation → validation, or when a blocker materially changes the situation.
- End with the verified outcome, remaining limitation, or blocked state before your final response. Distinguish implementation from tests, deployment, commit and merge; only claim what actually happened.
- Skip trivial Q&A and acknowledgements. Do not update per command/tool call, repeat unchanged text, or run timers/heartbeat loops. This avoids noise and unnecessary Board reordering.
- Keep it concise and user-readable, preferably in the user's language. Never include credentials, secret values, raw terminal output or copied peer instructions. Only update your own note.

Examples: `Inspecting mobile terminal scrolling`, `Implementing faster row-aligned swipes`, `Running mobile browser regression`, `Blocked: waiting for device verification`, `Implemented; tests passed; not committed`.

## Transport and lifetime

Use `canvas_set_progress({text:"Reviewing SHM synchronization"})` for your own progress. It enqueues only your own note through a dedicated process-scoped Pi → Scratch SHM channel, independent of peer messaging. Empty text clears it; maximum 500 JS UTF-16 code units. Queued is not applied or saved; Scratch validates/applies the update, with background receipts/UI warnings. Use canvas_read for observed state when needed, not polling. No automatic resend or HTTP fallback after a failed/unknown send. Session/activity reports are automatic through this same telemetry transport. Reload/new/resume/fork preserves transport and sequences. Temporary `SHM_STALE` pauses writes; the original epoch's heartbeat recovery resumes the same channel and freshly samples current session/activity, never replaying old progress/reports or waking a model. Closed/missing/replaced generations remain fenced.

Progress notes use only SHM telemetry. Agent HTTP PATCH accepts name and Agent Canvas geometry; validation failures reject the entire update.

Agent progress notes are at most 500 characters. Agent Canvas progress appears in the Board panel (single line, hover for full text), not on Agent windows. Card box Agents are excluded from Board; their progress remains available through SHM summaries. Idle retains progress; a new process clears it. Only update **your own** progress note. Independently, Agent Canvas `x,y,width,height` may be adjusted on any agent through the layout contract above; Card Box geometry remains human-only.
