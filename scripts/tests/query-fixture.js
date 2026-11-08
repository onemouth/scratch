import { createCanvasQueryClient } from '../../server/canvas-query-client.js';

// One real native endpoint for each owned fake PTY, never a live Agent.
const clients = new WeakMap();
export function queryFixture(child) {
  let client = clients.get(child);
  if (!client) {
    const env = child.options.env;
    client = createCanvasQueryClient({ config: JSON.parse(env.AGENT_CANVAS_SHM_QUERIES), name: env.AGENT_CANVAS_SHM_NAME, epoch: env.AGENT_CANVAS_SHM_EPOCH });
    clients.set(child, client); child.once('exit', () => client.close());
  }
  return client;
}
