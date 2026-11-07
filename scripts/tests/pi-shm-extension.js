// Diagnostic extension loaded only by the isolated real-Pi smoke driver.
import { canvasReadTool } from '../../server/pi-canvas-memory.js';
import { createCanvasSubscriptions } from '../../server/canvas-notify.js';
export default function diagnostic(pi) {
  let subscriptions;
  pi.on('session_shutdown', () => subscriptions?.close());
  pi.registerCommand('notify-smoke', {
    description: 'Isolated semaphore notification test; never calls an LLM',
    async handler(_args, ctx) {
      for (const name of ['canvas_subscribe', 'canvas_unsubscribe']) {
        if (!pi.getAllTools().some(tool => tool.name === name)) throw new Error(`${name} was not registered`);
      }
      subscriptions = createCanvasSubscriptions({ name: process.env.AGENT_CANVAS_SHM_NAME,
        epoch: process.env.AGENT_CANVAS_SHM_EPOCH, signalName: process.env.AGENT_CANVAS_SHM_NOTIFY,
        deliver: event => { ctx.ui.notify(`SHM_NOTIFY:${JSON.stringify(event)}`, 'info'); subscriptions.close(); },
        onError: error => ctx.ui.notify(`SHM_NOTIFY_ERROR:${error.code} ${error.message}`, 'error'),
      });
      subscriptions.subscribe({ agentId: 'isolated-fixture', events: ['idle'] });
      ctx.ui.notify('SHM_SUBSCRIBED', 'info');
    },
  });
  pi.registerCommand('memory-smoke', {
    description: 'Isolated shared-memory smoke test; never calls an LLM',
    async handler(_args, ctx) {
      if (!pi.getAllTools().some(tool => tool.name === 'canvas_read')) throw new Error('Production canvas_read was not registered');
      const previous = globalThis.fetch;
      try {
        globalThis.fetch = () => { throw new Error('HTTP forbidden during memory read'); };
        const result = await canvasReadTool({ name: process.env.AGENT_CANVAS_SHM_NAME, epoch: process.env.AGENT_CANVAS_SHM_EPOCH })
          .execute('smoke', { section: 'agents' });
        ctx.ui.notify(`SHM_SMOKE:${JSON.stringify(result)}`, result.isError ? 'error' : 'info');
      } finally { globalThis.fetch = previous; }
    },
  });
}
