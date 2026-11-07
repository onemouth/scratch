// Independent Pi-like notification receiver. Never connects to HTTP.
import { createCanvasSubscriptions } from '../../server/canvas-notify.js';
const [name, epoch, signalName, agentId] = process.argv.slice(2);
globalThis.fetch = () => { throw new Error('HTTP forbidden'); };
const controller = createCanvasSubscriptions({ name, epoch, signalName,
  deliver: event => process.send({ event }),
  onError: error => process.send({ error: error.code ?? error.message }),
});
controller.subscribe({ agentId, events: ['working', 'idle', 'stopped', 'removed'] });
process.send({ ready: true });
process.on('message', command => {
  if (command === 'close') { controller.close(); process.disconnect(); }
});
