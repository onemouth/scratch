import assert from 'node:assert/strict';
import { createCanvasTelemetryClient } from '../../server/canvas-telemetry-client.js';

// Fake PTY integration fixtures use the same native transport as a real Pi.
// Keep one producer per owned child until its exit; never reopen/retry reports.
const clients = new WeakMap();
export async function reportTelemetry(child, kind, data) {
  let client = clients.get(child);
  if (!client) {
    const env = child.options.env;
    client = createCanvasTelemetryClient({ config: JSON.parse(env.AGENT_CANVAS_SHM_TELEMETRY), name: env.AGENT_CANVAS_SHM_NAME, epoch: env.AGENT_CANVAS_SHM_EPOCH });
    clients.set(child, client);
    child.once('exit', () => client.close());
  }
  const sent = client.send(kind, data);
  for (let i = 0; i < 200; i++) {
    client.drain();
    const status = client.status(sent.seq);
    if (status.status !== 'queued') { assert.equal(status.status, 'applied', JSON.stringify(status)); return sent; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out awaiting fixture telemetry');
}
