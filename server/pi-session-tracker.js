// Loaded explicitly by Canvas-launched Pi processes. Reports session identity
// and turn state; never sends a prompt or resumes interrupted work.
export function assistantPreview(message, limit = 120) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return '';
  const plain = message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[\s#>*+-]+/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(plain);
  return characters.length <= limit ? plain : `${characters.slice(0, limit - 1).join('').trimEnd()}…`;
}

export default function sessionTracker(pi) {
  const base = process.env.AGENT_CANVAS_URL;
  const id = process.env.AGENT_CANVAS_ID;
  const runToken = process.env.AGENT_CANVAS_RUN;
  if (!base || !id || !runToken) return;
  let active = false;
  let ready = false;
  let sequence = 0;
  let preview = '';
  const report = (state, summary) => {
    if (!ready) return;
    const seq = ++sequence;
    void fetch(`${base}/api/agents/${id}/activity`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runToken, state, seq, ...(summary ? { summary } : {}) }), signal: AbortSignal.timeout(2000),
    }).catch(() => { /* Notifications must never block Pi. */ });
  };
  pi.on('agent_start', () => { active = true; preview = ''; report('working'); });
  pi.on('message_end', event => {
    const next = assistantPreview(event.message);
    if (next) preview = next;
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (ctx.isIdle() !== true) return;
    active = false; report('idle', preview);
  });
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    ready = true;
    active = ctx.isIdle() === false;
    report(active ? 'working' : 'idle');
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
