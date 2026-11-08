import assert from 'node:assert/strict';

// Runs inside the existing isolated browser fixture: no live Canvas data/PTYs.
export async function testCanvasLayout({ api, base, ev, send, wait, delay, cardId, layout }) {
  const note = await api('/notes', 'POST', { text: 'Layout lease fixture', x: 500, y: 0, width: 200, height: 180 });
  const selectors = [
    { kind: 'note', id: note.id, selector: `.react-flow__node-note[data-id="${note.id}"]`, handle: '.note-drag-handle', path: `/notes/${note.id}` },
    { kind: 'card', id: cardId, selector: `.react-flow__node-card[data-id="${cardId}"]`, handle: '.card-toolbar', path: `/card-placements/${cardId}` },
  ];
  const busy = async item => (await layout()).objects.find(o => o.kind === item.kind && o.id === item.id)?.busy;
  const expectBusy = async (item, value) => {
    for (let i = 0; i < 100; i++) { if (await busy(item) === value) return; await delay(30); }
    assert.fail(`Expected ${item.kind} busy=${value}`);
  };
  const rejectedMove = async item => {
    const response = await fetch(base + '/api' + item.path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 4000 }) });
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'LAYOUT_BUSY');
  };
  for (const item of selectors) {
    await wait('!!document.querySelector(' + JSON.stringify(item.selector) + ')');
    await ev('document.querySelector(".react-flow__controls-fitview").click()'); await delay(350);
    const point = await ev('(()=>{const r=document.querySelector(' + JSON.stringify(item.selector + ' ' + item.handle) + ').getBoundingClientRect();return{x:r.x+10,y:r.y+r.height/2}})()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x+25, y: point.y+20, buttons: 1 });
    await expectBusy(item, true); await rejectedMove(item);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x+25, y: point.y+20, button: 'left', buttons: 0, clickCount: 1 });
    await expectBusy(item, false);
    // Native resizing uses the same per-object lease and persists before release.
    await wait('!!document.querySelector(' + JSON.stringify(item.selector + ' .react-flow__resize-control.handle.bottom.right') + ')');
    const resize = await ev('(()=>{const r=document.querySelector(' + JSON.stringify(item.selector + ' .react-flow__resize-control.handle.bottom.right') + ').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...resize, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resize.x+25, y: resize.y+20, buttons: 1 });
    await expectBusy(item, true); await rejectedMove(item);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resize.x+25, y: resize.y+20, button: 'left', buttons: 0, clickCount: 1 });
    await expectBusy(item, false);
  }
  // An API reposition must neither pan nor zoom the human's viewport.
  const viewport = await ev('document.querySelector(".react-flow__viewport").style.transform');
  await api(`/notes/${note.id}`, 'PATCH', { x: 4000, y: 4000 });
  await delay(250);
  assert.equal(await ev('document.querySelector(".react-flow__viewport").style.transform'), viewport);
  await api(`/notes/${note.id}`, 'DELETE', {});
  console.log('Agent Canvas native drag/resize leases, busy rejection and viewport preservation passed');
}
