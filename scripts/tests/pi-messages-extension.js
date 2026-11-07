// Isolated real-Pi diagnostic. Registers the exact production extension/tools;
// a facade observes, then forwards each handoff to the actual Pi API.
import messagesExtension from '../../server/pi-canvas-messages.js';
export default function diagnostic(pi) {
  const tools = new Map();
  let context, contextReason;
  pi.on('session_start', (event, ctx) => {
    context = ctx; contextReason = event.reason;
    globalThis.fetch = () => { throw new Error('HTTP forbidden in SHM messaging smoke'); };
  });
  messagesExtension({
    on: (...args) => pi.on(...args),
    registerTool: tool => { tools.set(tool.name, tool); pi.registerTool(tool); },
    sendMessage: (message, options) => {
      pi.sendMessage(message, options);
      context.ui.notify(`SHM_MESSAGE_INBOUND:${JSON.stringify({ message, options, contextReason })}`, 'info');
    },
  });
  pi.on('session_start', (event, ctx) => {
    for (const name of ['canvas_send_message', 'canvas_message_status']) {
      if (!pi.getAllTools().some(tool => tool.name === name)) throw new Error(`Missing production tool ${name}`);
    }
    ctx.ui.notify(`SHM_MESSAGE_READY:${event.reason}`, 'info');
  });
  pi.on('session_shutdown', async (event, ctx) => {
    if (event.reason === 'quit') return;
    ctx.ui.notify(`SHM_MESSAGE_DETACHED:${event.reason}`, 'info');
    // Fixture-only handoff window: messages arrive while no Pi API is bound.
    await new Promise(resolve => setTimeout(resolve, 250));
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
  pi.registerCommand('message-status', {
    description: 'Read one production receipt without an LLM',
    async handler(args, ctx) {
      const result = await tools.get('canvas_message_status').execute('status', { messageId: args.trim() }, undefined, undefined, ctx);
      ctx.ui.notify(`SHM_MESSAGE_STATUS:${JSON.stringify(result.details)}`, 'info');
    },
  });
}
