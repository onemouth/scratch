// Loaded explicitly by Canvas-launched Pi processes. Reports identity only:
// never sends a prompt, starts a turn, or resumes interrupted work.
export default function sessionTracker(pi) {
  pi.on('session_start', async (_event, ctx) => {
    const base = process.env.AGENT_CANVAS_URL;
    const id = process.env.AGENT_CANVAS_ID;
    const runToken = process.env.AGENT_CANVAS_RUN;
    if (!base || !id || !runToken) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${base}/api/agents/${id}/session`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runToken, sessionFile: ctx.sessionManager.getSessionFile() ?? null, sessionId: ctx.sessionManager.getSessionId() }),
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok || response.status === 404 || response.status === 409) return;
      } catch { /* bounded retry; don't prevent interactive use */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (ctx.hasUI) ctx.ui.notify('Canvas could not record this session. Restore may use the session picker.', 'warning');
  });
}
