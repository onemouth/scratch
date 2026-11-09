// Isolated real-Pi diagnostic. Registers the exact production extension/tools;
// a facade observes, then forwards each handoff to the actual Pi API.
import messagesExtension from '../../server/pi-canvas-messages.js';
import trackerExtension from '../../server/pi-session-tracker.js';
import queryExtension from '../../server/pi-canvas-queries.js';
export default function diagnostic(pi) {
  const tools = new Map();
  let context, contextReason;
  pi.on('session_start', (event, ctx) => {
    context = ctx; contextReason = event.reason;
    globalThis.fetch = () => { throw new Error('HTTP forbidden in SHM messaging smoke'); };
  });
  queryExtension({ on: (...args) => pi.on(...args), registerTool: tool => { tools.set(tool.name, tool); pi.registerTool(tool); } });
  trackerExtension({ on: (...args) => pi.on(...args), registerTool: tool => { tools.set(tool.name, tool); pi.registerTool(tool); } });
  messagesExtension({
    on: (...args) => pi.on(...args),
    registerTool: tool => { tools.set(tool.name, tool); pi.registerTool(tool); },
    sendMessage: (message, options) => {
      pi.sendMessage(message, options);
      context.ui.notify(`SHM_MESSAGE_INBOUND:${JSON.stringify({ message, options, contextReason })}`, 'info');
    },
  });
  pi.on('session_start', (event, ctx) => {
    for (const name of ['canvas_send_message', 'canvas_message_status', 'canvas_set_progress', 'canvas_agents', 'canvas_layout']) {
      if (!pi.getAllTools().some(tool => tool.name === name)) throw new Error(`Missing production tool ${name}`);
    }
    ctx.ui.notify(`SHM_TELEMETRY_CONTEXT:${JSON.stringify({ reason: event.reason, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null })}`, 'info');
    ctx.ui.notify(`SHM_MESSAGE_READY:${event.reason}`, 'info');
  });
  pi.on('session_shutdown', async (event, ctx) => {
    if (event.reason === 'quit') return;
    ctx.ui.notify(`SHM_MESSAGE_DETACHED:${event.reason}`, 'info');
    // Fixture-only handoff window: messages arrive while no Pi API is bound.
    await new Promise(resolve => setTimeout(resolve, 250));
  });
  pi.registerCommand('transport-drain', {
    description: 'Drain the actual process transports for isolated heartbeat/status testing',
    handler(_args, ctx) {
      process[Symbol.for('agent-canvas.telemetry.process.v1')].client.drain();
      process[Symbol.for('agent-canvas.messaging.process.v1')].client.drain();
      ctx.ui.notify('SHM_TRANSPORT_DRAINED', 'info');
    },
  });
  pi.registerCommand('message-reload', {
    description: 'Reload the real extension runtime without an LLM',
    async handler(_args, ctx) { await ctx.reload(); return; },
  });
  pi.registerCommand('message-smoke', {
    description: 'Invoke the production SHM send tool without an LLM',
    async handler(args, ctx) {
      const result = await tools.get('canvas_send_message').execute('smoke', JSON.parse(args), undefined, undefined, ctx);
      ctx.ui.notify(`SHM_MESSAGE_SENT:${JSON.stringify(result.details)}`, 'info');
    },
  });
  pi.registerCommand('telemetry-smoke', {
    description: 'Invoke production progress reporting without an LLM',
    async handler(args, ctx) {
      const result = await tools.get('canvas_set_progress').execute('progress', { text: args }, undefined, undefined, ctx);
      ctx.ui.notify(`SHM_TELEMETRY_SENT:${JSON.stringify(result.details)}`, 'info');
    },
  });
  pi.registerCommand('query-smoke', {
    description: 'Invoke precise SHM queries without an LLM',
    async handler(args, ctx) {
      const agent = await tools.get('canvas_agents').execute('agent', { agentId: args.trim() }, undefined, undefined, ctx);
      const layout = await tools.get('canvas_layout').execute('layout', {}, undefined, undefined, ctx);
      if (agent.isError || layout.isError) throw new Error(JSON.stringify({ agent, layout }));
      ctx.ui.notify(`SHM_QUERY_RESULT:${JSON.stringify({ agent: agent.details, layout: layout.details })}`, 'info');
    },
  });
  pi.registerCommand('telemetry-status', {
    description: 'Inspect process-private receipt cache for the diagnostic only',
    handler(args, ctx) {
      const client = process[Symbol.for('agent-canvas.telemetry.process.v1')].client;
      client.drain();
      ctx.ui.notify(`SHM_TELEMETRY_STATUS:${JSON.stringify(client.status(Number(args)))}`, 'info');
    },
  });
  pi.registerCommand('message-status', {
    description: 'Read one production receipt without an LLM',
    async handler(args, ctx) {
      const result = await tools.get('canvas_message_status').execute('status', { messageId: args.trim() }, undefined, undefined, ctx);
      ctx.ui.notify(`SHM_MESSAGE_STATUS:${JSON.stringify(result.details)}`, 'info');
    },
  });
}
