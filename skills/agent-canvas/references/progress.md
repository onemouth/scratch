# Update your progress note

Use `canvas_set_progress({text:"Reviewing SHM synchronization"})` for your own progress. It enqueues only your own note through a dedicated process-scoped Pi → Scratch SHM channel, independent of peer messaging. Empty text clears it; maximum 500 JS UTF-16 code units. Queued is not applied or saved; Scratch validates/applies the update, with background receipts/UI warnings. Use canvas_read for observed state when needed, not polling. No automatic resend or HTTP fallback after a failed/unknown send. Session/activity reports are automatic through this same telemetry transport. Reload/new/resume/fork preserves transport and sequences. Temporary `SHM_STALE` pauses writes; the original epoch's heartbeat recovery resumes the same channel and freshly samples current session/activity, never replaying old progress/reports or waking a model. Closed/missing/replaced generations remain fenced.

Progress notes use only SHM telemetry. Agent HTTP PATCH accepts name and Agent Canvas geometry; validation failures reject the entire update.

Agent progress notes are at most 500 characters and appear on the node. Only update **your own** progress note. Independently, Agent Canvas `x,y,width,height` may be adjusted on any agent through the layout contract above; Card Box geometry remains human-only.
