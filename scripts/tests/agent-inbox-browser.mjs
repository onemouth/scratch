import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createCanvasMessageClient } from '../../server/canvas-message-client.js';
import { inboxMessageContent } from '../../shared/canvas-inbox.js';

// Runs only inside the disposable views fixture, after its terminal-count
// assertions. All PTYs are fake; this never visits or changes the live Canvas.
export async function testAgentInbox({ app, api, ev, send, wait, delay, boxAgentId }) {
  const clients = [];
  const frames = [];
  const client = id => {
    const env = app.runtime.processes.get(id).options.env;
    const value = createCanvasMessageClient({ config: JSON.parse(env.AGENT_CANVAS_SHM_MESSAGES), name: env.AGENT_CANVAS_SHM_NAME,
      epoch: env.AGENT_CANVAS_SHM_EPOCH, deliver: frame => frames.push(frame) });
    clients.push(value); return value;
  };
  const actualClick = async selector => {
    const point = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  const custom = frame => ({ role: 'custom', customType: 'canvas-agent-message', content: inboxMessageContent(frame),
    details: { messageId: frame.messageId, sourceId: frame.sourceId, sourceGeneration: frame.sourceGeneration } });
  try {
    // Native scroll gestures use the host window's bounds, not just emulated
    // layout metrics. The fixture's earlier iframe tests use their own bridge.
    const { windowId } = await send('Browser.getWindowForTarget');
    await send('Browser.setWindowBounds', { windowId, bounds: { width: 1600, height: 1200 } });
    await ev(`document.querySelector('.zettel-card.maximized [aria-label^="Return card"]')?.click()`);
    const source = await api('/agents', 'POST', { name: 'Inbox sender', workdir: process.cwd() });
    const sender = client(source.id), receiver = client(boxAgentId);
    const text = '<img src=x onerror="window.inboxInjected=true">\n' + 'Long peer text with 中文 and 🧋; never execute as HTML.\n'.repeat(80);
    const sent = sender.send({ agentId: boxAgentId, text });
    await wait(`!!document.querySelector('[data-id="${source.id}"]')`);
    await ev(`Array.from(document.querySelectorAll('.workspace-nav button')).find(button=>button.textContent.trim()==='Card box')?.click()`);
    await wait(`document.querySelector('.card-box-agent-sidebar .agent-inbox-trigger')?.textContent.trim()==='1'`);
    assert.equal(await ev(`document.querySelector('.card-box-agent-sidebar .agent-inbox-trigger svg')`), null, 'Inbox trigger shows only the count, no mailbox icon');
    await ev(`window.inboxTerminal=document.querySelector('.card-box-agent-sidebar .xterm')`);
    const writes = [...app.runtime.processes.get(boxAgentId).writes];
    await actualClick('.card-box-agent-sidebar .agent-inbox-trigger');
    await wait(`document.querySelector('.agent-inbox-text')?.textContent.includes('Long peer text')`);
    assert.equal(await ev(`document.querySelector('.agent-inbox-text').textContent`), text);
    assert.equal(await ev(`document.querySelector('.agent-inbox-message-meta strong').textContent`), 'Inbox sender');
    assert.equal(await ev(`!!document.querySelector('.agent-inbox-text img') || !!window.inboxInjected`), false);
    assert.equal(await ev(`document.querySelectorAll('.agent-inbox-popover button').length`), 1, 'Only close, no message actions');
    assert.equal(await ev(`document.querySelector('.agent-inbox-popover').parentElement===document.body`), true);
    assert.equal(await ev(`(()=>{const r=document.querySelector('.agent-inbox-popover').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`), true);
    const before = await api('/card-box/views');
    const point = await ev(`(()=>{const r=document.querySelector('.agent-inbox-text').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await delay(300);
    await send('Input.synthesizeScrollGesture', { ...point, yDistance: -350, speed: 1000, gestureSourceType: 'mouse' });
    try { await wait(`document.querySelector('.agent-inbox-text').scrollTop>0`); }
    catch (error) {
      const details = await ev(`(()=>{const e=document.querySelector('.agent-inbox-text'),hit=document.elementFromPoint(${point.x},${point.y});return{scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflow:getComputedStyle(e).overflowY,rect:e.getBoundingClientRect().toJSON(),hit:hit?.outerHTML.slice(0,250)}})()`);
      throw new Error(error.message + '\\n' + JSON.stringify(details));
    }
    assert.deepEqual((await api('/card-box/views')).views, before.views, 'Inbox scroll must not change Canvas viewports');
    assert.deepEqual(app.runtime.processes.get(boxAgentId).writes, writes, 'Viewing/scrolling never sends terminal input');
    assert.equal((await api(`/agents/${boxAgentId}/inbox`)).messages[0].messageId, sent.messageId, 'Viewing does not mark consumed');
    await ev(`document.querySelector('.agent-inbox-text').scrollTop=0;document.querySelector('.agent-inbox-text').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 });
    await wait(`document.querySelector('.agent-inbox-text').scrollTop>0`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await wait(`!document.querySelector('.agent-inbox-popover')`);
    await wait(`document.activeElement?.classList.contains('agent-inbox-trigger')`);
    // Malformed responses and a late rejected fetch must not become an empty
    // success or clobber details fetched after closing/reopening the popover.
    const endpoint = `/api/agents/${boxAgentId}/inbox`;
    await ev(`window.inboxOriginalFetch=window.fetch;window.fetch=(url,options)=>String(url)===${JSON.stringify(endpoint)}?Promise.resolve(new Response('{}',{headers:{'Content-Type':'application/json'}})):window.inboxOriginalFetch(url,options)`);
    await actualClick('.card-box-agent-sidebar .agent-inbox-trigger');
    await wait(`!!document.querySelector('.agent-inbox-popover [role="alert"]')`);
    assert.equal(await ev(`document.querySelector('.agent-inbox-popover').textContent.includes('No pending messages.')`), false);
    await ev(`document.querySelector('[aria-label="Close pending inbox"]').click();window.fetch=(url,options)=>String(url)===${JSON.stringify(endpoint)}?new Promise((_resolve,reject)=>{window.inboxDeferredReject=reject}):window.inboxOriginalFetch(url,options)`);
    await wait(`!document.querySelector('.agent-inbox-popover')`);
    await actualClick('.card-box-agent-sidebar .agent-inbox-trigger');
    await wait(`!!document.querySelector('.agent-inbox-popover') && typeof window.inboxDeferredReject==='function'`);
    await ev(`document.querySelector('[aria-label="Close pending inbox"]').click();window.fetch=window.inboxOriginalFetch`);
    await wait(`!document.querySelector('.agent-inbox-popover')`);
    await actualClick('.card-box-agent-sidebar .agent-inbox-trigger'); await wait(`!!document.querySelector('.agent-inbox-message')`);
    await ev(`window.inboxDeferredReject(new Error('Obsolete request must not overwrite fresh details'))`); await delay(50);
    assert.equal(await ev(`!!document.querySelector('.agent-inbox-popover [role="alert"]')`), false);
    const delivered = frames.find(frame => frame.messageId === sent.messageId);
    receiver.observeContext([custom(delivered)]); receiver.observeInboxRequest({ messages: [custom(delivered)] });
    receiver.observeResponse({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'actual response' } });
    await wait(`document.querySelector('.agent-inbox-popover')?.textContent.includes('No pending messages.')`);
    assert.equal(await ev(`document.querySelector('.card-box-agent-sidebar .agent-inbox-trigger').textContent.trim()`), '0');
    assert.equal(await ev(`window.inboxTerminal===document.querySelector('.card-box-agent-sidebar .xterm')`), true);

    sender.send({ agentId: boxAgentId, text: 'Unresolved at process end' });
    await wait(`document.querySelector('.agent-inbox-text')?.textContent==='Unresolved at process end'`);
    await api(`/agents/${boxAgentId}/stop`, 'POST', {});
    await wait(`document.querySelector('.agent-inbox-unavailable')?.textContent.includes('Process ended')`);
    assert.equal(await ev(`document.querySelector('.agent-inbox-popover').textContent.includes('No pending messages.')`), false);
    assert.equal(await ev(`document.querySelector('.card-box-agent-sidebar .agent-inbox-trigger').textContent.trim()`), '?');
    await api(`/agents/${boxAgentId}/resume`, 'POST', {});
    const freshReceiver = client(boxAgentId);
    await wait(`!!document.querySelector('.agent-inbox-warning')`);
    await wait(`document.querySelector('.card-box-agent-sidebar .agent-inbox-trigger')?.textContent.trim()==='0'`);
    assert.equal(await ev(`document.querySelectorAll('.agent-inbox-message').length`), 0, 'Restart never transfers old messages');
    await ev(`document.querySelector('[aria-label="Close pending inbox"]').click()`);

    // Same component in Agent Canvas, at canvas zoom and while maximized.
    freshReceiver.send({ agentId: source.id, text: 'Agent Canvas pending inbox' });
    await ev(`Array.from(document.querySelectorAll('.workspace-nav button')).find(button=>button.textContent.trim()==='Agent Canvas').click()`);
    const node = `.react-flow__node-agent[data-id="${source.id}"]`;
    await wait(`document.querySelector(${JSON.stringify(node + ' .agent-inbox-trigger')})?.textContent.trim()==='1'`);
    await ev(`document.querySelector('.react-flow__controls-fitview').click()`); await delay(150);
    await ev(`document.querySelector(${JSON.stringify(node + ' .agent-inbox-trigger')}).click()`);
    await wait(`document.querySelector('.agent-inbox-text')?.textContent==='Agent Canvas pending inbox'`);
    assert.equal(await ev(`(()=>{const r=document.querySelector('.agent-inbox-popover').getBoundingClientRect();return r.width>300&&r.right<=innerWidth&&r.bottom<=innerHeight})()`), true, 'Portal is readable independently of Canvas scale');
    await ev(`document.querySelector('[aria-label="Close pending inbox"]').click();document.querySelector('[aria-label="Maximize Inbox sender"]').click()`);
    await wait(`!!document.querySelector(${JSON.stringify(node + ' .agent-node.maximized')})`);
    assert.equal(await ev(`[...document.querySelectorAll('button')].some(b=>/Vault/.test(b.textContent)&&b.getClientRects().length>0)`), false, 'No Vault button on maximized Agent Canvas agent');
    await actualClick(node + ' .agent-inbox-trigger'); await wait(`!!document.querySelector('.agent-inbox-message')`);
    assert.equal(await ev(`getComputedStyle(document.querySelector('.agent-inbox-popover')).position`), 'fixed');
    for (let i = 0; i < 5; i++) freshReceiver.send({ agentId: source.id, text: `Additional pending message ${i}` });
    await wait(`document.querySelectorAll('.agent-inbox-message').length===6`);
    if (process.env.CANVAS_INBOX_SCREENSHOT) await writeFile(process.env.CANVAS_INBOX_SCREENSHOT, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });
    await wait(`(()=>{const r=document.querySelector('.agent-inbox-popover')?.getBoundingClientRect();return r&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await ev(`document.querySelector('[aria-label="Close pending inbox"]').click()`);
    console.log('Inbox browser passed: counts/details, literal untrusted text, read-only viewing, scroll/Escape/focus, live B removal, process-end/restart warning, zoom/dock/maximize and viewport clamping.');
  } finally { for (const instance of clients) instance.close(); }
}
