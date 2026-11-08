// Isolated fixture: no live Canvas, persistence files, credentials or LLM calls.
import { nativeMemory } from '../../shared/canvas-memory.js';
import { canvasReadTool } from '../../server/pi-canvas-memory.js';
const [mode, name, epoch] = process.argv.slice(2);
if (mode === 'tool') {
  globalThis.fetch = () => { throw new Error('HTTP is forbidden in memory fixture'); };
  const result = await canvasReadTool({ name, epoch }).execute('fixture', { section: 'agents' });
  console.log(JSON.stringify(result));
} else {
  const native = nativeMemory(), writer = native.create(name, 262144);
  const write = n => native.write(writer, Buffer.from(JSON.stringify({ n, payload: (n % 2 ? '甲' : '乙').repeat(20000) })));
  write(0); process.send({ ready: true });
  const heartbeat = setInterval(() => native.touch(writer), 1000);
  process.on('message', async command => {
    if (command === 'churn') {
      for (let n = 1; n <= 400; n++) { write(n); await new Promise(resolve => setImmediate(resolve)); }
      process.send({ done: true });
    } else if (command === 'close') {
      clearInterval(heartbeat); native.close(writer); process.disconnect();
    }
  });
}
