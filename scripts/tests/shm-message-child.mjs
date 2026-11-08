import { nativeMemory } from '../../shared/canvas-memory.js';
const native = nativeMemory();
const input = native.queueOpen(process.argv[2], 'consumer'), output = native.queueOpen(process.argv[3], 'producer');
let received = 0;
const timer = setInterval(() => {
  for (let i = 0; i < 16 && native.queueState(output).used < 16; i++) {
    const entry = native.queuePeek(input); if (!entry) break;
    const value = JSON.parse(entry.payload.toString());
    if (value.i !== received++) throw new Error('Out of order or torn queue message');
    native.queuePush(output, entry.payload); native.queueShift(input, entry.sequence);
  }
}, 1);
process.on('message', message => {
  if (message === 'done') {
    if (received !== 4000) throw new Error('Incomplete exchange');
    clearInterval(timer); native.queueClose(input); native.queueClose(output); process.disconnect();
  }
});
