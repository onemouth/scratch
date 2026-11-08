import { bindTelemetryProcess, detachTelemetryProcess, warnTelemetry } from './pi-telemetry-process.js';
import { telemetryError } from '../shared/canvas-telemetry.js';

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
  const id = process.env.AGENT_CANVAS_ID;
  if (!id) return;
  const owner = Symbol('Pi telemetry context');
  let broker, preview = '';
  const active = () => broker?.binding?.owner === owner && !broker.closed;
  const publish = (kind, data) => {
    if (!active()) return;
    try { return broker.publish(kind, data); }
    catch (error) {
      warnTelemetry(broker, error.code ?? 'TELEMETRY_ERROR');
    }
  };
  pi.on('agent_start', () => { if (active()) { preview = ''; publish('activity', { state: 'working' }); } });
  pi.on('message_end', event => {
    if (!active()) return;
    const next = assistantPreview(event.message);
    if (next) preview = next;
  });
  pi.on('agent_settled', (_event, ctx) => {
    if (active() && ctx.isIdle() === true) publish('activity', { state: 'idle', ...(preview ? { summary: preview } : {}) });
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!['tui', 'rpc'].includes(ctx.mode)) return;
    try {
      const config = JSON.parse(process.env.AGENT_CANVAS_SHM_TELEMETRY);
      broker = bindTelemetryProcess({ config, id, ctx, owner,
        name: process.env.AGENT_CANVAS_SHM_NAME, epoch: process.env.AGENT_CANVAS_SHM_EPOCH,
        snapshot: () => ({
          session: { sessionFile: ctx.sessionManager.getSessionFile() ?? null, sessionId: ctx.sessionManager.getSessionId() },
          activity: { state: ctx.isIdle() === false ? 'working' : 'idle' },
        }) });
      preview = '';
      publish('activity', { state: ctx.isIdle() === false ? 'working' : 'idle' });
      await publish('session', { sessionFile: ctx.sessionManager.getSessionFile() ?? null, sessionId: ctx.sessionManager.getSessionId() });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Canvas telemetry unavailable: ${error.code ?? 'TELEMETRY_CONFIG'}. No HTTP fallback.`, 'warning');
    }
  });
  pi.on('session_shutdown', (event = { reason: 'quit' }) => detachTelemetryProcess(broker, owner, event.reason));
  pi.registerTool({
    name: 'canvas_set_progress', label: 'Set Canvas progress',
    description: 'Enqueue your own progress note through the dedicated Pi-to-Scratch SHM telemetry channel. Maximum 500 characters; empty text clears it. Returns queued, not applied or durably saved. Scratch validates and updates Canvas; use canvas_read for observed state. Process-scoped across reload/new/resume/fork. No HTTP fallback, automatic resend or direct Canvas-state writes.',
    promptSnippet: 'Report your own progress through SHM',
    promptGuidelines: ['Use canvas_set_progress for your own Canvas progress note when available; never update another agent’s progress.'],
    parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 500 } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_id, { text }, signal) {
      signal?.throwIfAborted();
      if (!active()) throw telemetryError('TELEMETRY_CONTEXT', 'Telemetry context is not active');
      const value = broker.publish('progress', { text });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    },
  });
}
