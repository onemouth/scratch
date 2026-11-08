// Disposable real-Pi fixture: production messaging extension + in-process fake
// provider. No network, real model calls, live sessions or live Canvas objects.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import messagesExtension from '../../server/pi-canvas-messages.js';

export default function inboxFixture(pi) {
  let mode = 'ok', context;
  pi.registerProvider('inbox-fixture', {
    api: 'inbox-fixture-api', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1/fixture-no-network',
    models: [{ id: 'test', name: 'Inbox fake model', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
    streamSimple(model, input, options) {
      const stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          await options.onPayload?.({ messages: input.messages });
          context.ui.notify(`INBOX_PROVIDER:${mode}`, 'info');
          if (mode === 'hold') await new Promise(resolve => {
            if (options.signal?.aborted) resolve();
            else options.signal?.addEventListener('abort', resolve, { once: true });
          });
          if (mode === 'fail' || options.signal?.aborted) {
            message.stopReason = options.signal?.aborted ? 'aborted' : 'error';
            message.errorMessage = 'Owned fixture request ended before response';
            stream.push({ type: 'error', reason: message.stopReason, error: message }); stream.end(); return;
          }
          stream.push({ type: 'start', partial: message });
          message.content = [{ type: 'text', text: '' }];
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content[0].text = 'fixture response';
          stream.push({ type: 'text_delta', contentIndex: 0, delta: 'fixture response', partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: 'fixture response', partial: message });
          stream.push({ type: 'done', reason: 'stop', message }); stream.end();
        } catch (error) {
          message.stopReason = 'error'; message.errorMessage = String(error);
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end();
        }
      })();
      return stream;
    },
  });
  pi.on('session_start', async (event, ctx) => {
    context = ctx;
    globalThis.fetch = () => { throw new Error('Network forbidden in Inbox fixture'); };
    await pi.setModel(ctx.modelRegistry.find('inbox-fixture', 'test'));
    ctx.ui.notify(`INBOX_READY:${event.reason}`, 'info');
  });
  pi.on('context', event => mode === 'filtered' ? { messages: event.messages.filter(message => message.customType !== 'canvas-agent-message') } : undefined);
  messagesExtension(pi);
  pi.registerCommand('inbox-mode', { description: 'Set owned fake provider mode', handler(args, ctx) {
    mode = args.trim(); ctx.ui.notify(`INBOX_MODE:${mode}`, 'info');
  } });
  pi.registerCommand('inbox-reload', { description: 'Reload isolated fixture', async handler(_args, ctx) { await ctx.reload(); } });
}
