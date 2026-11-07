// Diagnostic extension loaded only by the isolated real-Pi smoke driver.
import { canvasReadTool } from '../../server/pi-canvas-memory.js';
export default function diagnostic(pi) {
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
