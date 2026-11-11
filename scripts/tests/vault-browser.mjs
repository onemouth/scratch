import assert from 'node:assert/strict';

// Runs only in the disposable views fixture. No live data, credentials or models.
export async function testVault({ app, api, base, ev, send, wait, delay, boxAgentId }) {
  const password = 'browser fixture password', secret = 'fixture-secret <b>literal</b> 🧋', updated = 'updated-fixture-secret';
  const click = async (scope, text) => {
    await wait(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`);
    await ev(`[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  };
  const fill = (scope, name, value) => ev(`(()=>{const label=[...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(l=>l.firstChild.textContent.trim()===${JSON.stringify(name)});if(!label)throw Error('Missing label '+${JSON.stringify(name)});const e=label.querySelector('input,textarea');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const human = async (path, method = 'GET', body) => {
    const response = await fetch(base + '/api/vault' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Vault-Control': app.vaultControlCode }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const close = async () => { await ev(`document.querySelector('[aria-label="Close Vault"]')?.click()`); await wait(`!document.querySelector('.vault-panel')`); };
  const open = async () => { await click('.top-actions', 'Vault'); await wait(`!!document.querySelector('.vault-panel')`); };
  const unlocked = () => wait(`document.querySelector('.vault-panel .vault-state')?.textContent==='Unlocked'`);
  const unlock = async () => {
    await wait(`[...document.querySelectorAll('.vault-panel button')].some(b=>b.textContent==='Unlock'&&!b.disabled)`);
    await fill('.vault-panel', 'Master password', password); await click('.vault-panel', 'Unlock'); await unlocked();
  };
  const add = async (key, value) => {
    await fill('.vault-create', 'Key name', key); await fill('.vault-create', 'Encrypted value', value); await click('.vault-create', 'Add key');
    await wait(`document.querySelector('.vault-success')?.textContent==='Key added.'`);
    return (await human('/entries')).entries.find(entry => entry.key === key);
  };
  const scope = id => `.vault-entry[data-entry-id="${id}"]`;
  await ev(`document.querySelector('.agent-node.maximized [aria-label^="Return "]')?.click();document.querySelector('.zettel-card.maximized [aria-label^="Return card"]')?.click()`);
  await click('.workspace-nav', 'Card box'); await wait(`!!document.querySelector('.card-box-agent-sidebar .xterm')`);
  await ev(`window.vaultTerminal=document.querySelector('.card-box-agent-sidebar .xterm')`);
  const writes = [...app.runtime.processes.get(boxAgentId).writes];
  const libraryBefore = await api('/cards');
  const placementsBefore = structuredClone(app.snapshot().cardPlacements);
  const memberships = () => app.snapshot().cardBox.views.map(view => ({ id: view.id, cards: view.placements.map(item => item.cardId) }));
  const membershipBefore = memberships();
  await open(); await fill('.vault-panel', 'Vault control code', app.vaultControlCode); await click('.vault-panel', 'Connect human control');
  await wait(`document.querySelector('.vault-panel')?.textContent.includes('Human control connected')`);
  await fill('.vault-panel', 'Master password', password); await fill('.vault-panel', 'Confirm master password', password); await click('.vault-panel', 'Create Vault'); await unlocked();
  assert.deepEqual(await api('/cards'), libraryBefore, 'Setup creates no library card');
  assert.equal(app.snapshot().cards.some(card => card.type === 'vault'), false);
  assert.equal(await ev(`[...document.querySelectorAll('.top-actions button')].some(b=>b.textContent==='＋ Vault')`), false);
  const first = await add('BROWSER_TOKEN', secret);
  await fill('.vault-create', 'Key name', 'BROWSER_TOKEN'); await fill('.vault-create', 'Encrypted value', 'must-not-replace'); await click('.vault-create', 'Add key');
  await wait(`!!document.querySelector('.vault-panel [role="alert"]')`);
  assert.equal((await human('/entries')).entries.length, 1); assert.equal((await human('/entries/' + first.id + '/value')).value, secret);
  await add('OTHER_TOKEN', 'separate-secret');
  assert.deepEqual(await api('/cards'), libraryBefore, 'Adding keys creates no library card');
  assert.equal((await human('/entries')).entries.length, 2);
  assert.equal(JSON.stringify(await api('/state')).includes(secret), false);
  assert.equal(await ev(`JSON.stringify(localStorage).includes(${JSON.stringify(secret)})||JSON.stringify(sessionStorage).includes(${JSON.stringify(secret)})`), false);
  assert.equal(await ev(`JSON.stringify(localStorage).includes(${JSON.stringify(app.vaultControlCode)})||JSON.stringify(sessionStorage).includes(${JSON.stringify(app.vaultControlCode)})`), false);
  await click(scope(first.id), 'Reveal value'); await wait(`document.querySelector(${JSON.stringify(scope(first.id) + ' pre')})?.textContent===${JSON.stringify(secret)}`);
  assert.equal(await ev(`!!document.querySelector(${JSON.stringify(scope(first.id) + ' pre b')})`), false);
  await click(scope(first.id), 'Edit key…'); await fill(scope(first.id), 'Encrypted value', updated); await click(scope(first.id), 'Save key');
  await wait(`document.querySelector(${JSON.stringify(scope(first.id) + ' pre')})?.textContent===${JSON.stringify(updated)}`);

  // Delay a successful save, lock/unlock and start a newer editor before releasing it.
  await ev(`window.vaultOriginalFetch=window.fetch;window.vaultSaveHeld=false;window.fetch=async(url,options)=>{const response=await window.vaultOriginalFetch(url,options);if(String(url)===${JSON.stringify('/api/vault/entries/' + first.id)}&&options?.method==='PATCH'){window.vaultSaveHeld=true;await new Promise(resolve=>window.vaultSaveRelease=resolve)}return response}`);
  await click(scope(first.id), 'Edit key…'); await click(scope(first.id), 'Save key'); await wait('window.vaultSaveHeld');
  await human('/lock', 'POST', {}); await wait(`document.querySelector('.vault-state')?.textContent==='Locked'`);
  await ev('window.fetch=window.vaultOriginalFetch'); await unlock();
  await click(scope(first.id), 'Reveal value'); await wait(`!!document.querySelector(${JSON.stringify(scope(first.id) + ' pre')})`);
  await click(scope(first.id), 'Edit key…'); await fill(scope(first.id), 'Encrypted value', 'NEW-UNSAVED-DRAFT');
  await ev('window.vaultSaveRelease()'); await delay(100);
  assert.equal(await ev(`document.querySelector(${JSON.stringify(scope(first.id) + ' textarea')})?.value`), 'NEW-UNSAVED-DRAFT');
  await click(scope(first.id), 'Cancel'); await click(scope(first.id), 'Hide value');

  // A reveal already returned by the backend must not appear after a lock.
  await ev(`window.vaultOriginalFetch=window.fetch;window.vaultHeld=false;window.fetch=async(url,options)=>{const response=await window.vaultOriginalFetch(url,options);if(String(url)===${JSON.stringify('/api/vault/entries/' + first.id + '/value')}){window.vaultHeld=true;await new Promise(resolve=>window.vaultRelease=resolve)}return response}`);
  await click(scope(first.id), 'Reveal value'); await wait('window.vaultHeld');
  await human('/lock', 'POST', {}); await wait(`document.querySelector('.vault-state')?.textContent==='Locked'`);
  await ev('window.fetch=window.vaultOriginalFetch;window.vaultRelease()'); await delay(100);
  assert.equal(await ev(`!!document.querySelector(${JSON.stringify(scope(first.id) + ' pre')})`), false); await unlock();
  await fill('.vault-create', 'Encrypted value', 'UNSAVED-SENSITIVE-DRAFT'); await click('.vault-panel', 'Lock now'); await unlock();
  assert.equal(await ev(`document.querySelector('.vault-create textarea').value`), '');
  await ev(`window.vaultPollHolds=[];window.vaultHoldPolls=true;window.vaultOriginalFetch=window.fetch;window.fetch=async(url,options)=>{const response=await window.vaultOriginalFetch(url,options);if(window.vaultHoldPolls&&['/api/vault/status','/api/vault/control'].includes(String(url)))await new Promise(resolve=>window.vaultPollHolds.push(resolve));return response}`);
  await wait('window.vaultPollHolds.length>0'); await human('/lock', 'POST', {}); await wait(`document.querySelector('.vault-state')?.textContent==='Locked'`);
  await ev('window.vaultHoldPolls=false;window.fetch=window.vaultOriginalFetch;window.vaultPollHolds.forEach(resolve=>resolve())'); await delay(100);
  assert.equal(await ev(`document.querySelector('.vault-state').textContent`), 'Locked'); await unlock();

  const token = app.runtime.processes.get(boxAgentId).options.env.AGENT_CANVAS_VAULT_TOKEN;
  const retrieve = key => fetch(base + '/api/vault/retrieve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ key }) });
  const decide = async (key, decision) => {
    const selector = '[aria-labelledby="vault-requests-title"] .vault-list li';
    await wait(`![...document.querySelectorAll(${JSON.stringify(selector)})].some(li=>li.querySelector('strong')?.textContent===${JSON.stringify(key)})`);
    const pending = retrieve(key);
    await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(li=>li.querySelector('strong')?.textContent===${JSON.stringify(key)}&&[...li.querySelectorAll('button')].some(b=>b.textContent===${JSON.stringify(decision)}&&!b.disabled))`);
    await ev(`(()=>{const li=[...document.querySelectorAll(${JSON.stringify(selector)})].find(li=>li.querySelector('strong')?.textContent===${JSON.stringify(key)});[...li.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(decision)}).click()})()`);
    return pending;
  };
  let response = await decide('BROWSER_TOKEN', 'Allow once'); assert.equal(response.status, 200); assert.equal(await response.text(), updated);
  assert.equal((await human('/control')).grants.length, 0);
  response = await decide('BROWSER_TOKEN', 'Allow process'); assert.equal(await response.text(), updated);
  response = await decide('OTHER_TOKEN', 'Deny'); assert.equal(response.status, 403); await response.text();
  assert.equal((await human('/control')).grants.length, 1, 'One key grant does not grant another key');
  await wait(`[...document.querySelectorAll('.vault-list button')].some(b=>b.textContent==='Revoke'&&!b.disabled)`); await click('.vault-list', 'Revoke');
  assert.equal((await human('/control')).grants.length, 0);
  response = await decide('BROWSER_TOKEN', 'Allow process'); await response.text();
  await click(scope(first.id), 'Reveal value'); await wait(`!!document.querySelector(${JSON.stringify(scope(first.id) + ' pre')})`);
  await click(scope(first.id), 'Edit key…'); await fill(scope(first.id), 'Key name', 'RENAMED_TOKEN'); await click(scope(first.id), 'Save key');
  await wait(`document.querySelector(${JSON.stringify(scope(first.id) + ' .vault-entry-head strong')})?.textContent==='RENAMED_TOKEN'`);
  assert.equal((await human('/control')).grants.length, 0, 'Rename revokes its key grant');
  response = await retrieve('BROWSER_TOKEN'); assert.equal(response.status, 404); await response.text();
  await ev('window.vaultOriginalConfirm=window.confirm;window.vaultDeletionPrompted=false;window.confirm=()=>{window.vaultDeletionPrompted=true;return true}');
  await click(scope(first.id), 'Delete key…'); await wait(`!document.querySelector(${JSON.stringify(scope(first.id))})`);
  await ev('window.confirm=window.vaultOriginalConfirm'); assert.equal(await ev('window.vaultDeletionPrompted'), true);
  assert.deepEqual(await api('/cards'), libraryBefore, 'Deleting a key cannot affect cards');
  const recreated = await add('RENAMED_TOKEN', 'fresh-secret'); assert.notEqual(recreated.id, first.id);
  response = await decide('RENAMED_TOKEN', 'Deny'); assert.equal(response.status, 403); await response.text();
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait(`!document.querySelector('.vault-panel')`);
  assert.deepEqual(app.runtime.processes.get(boxAgentId).writes, writes, 'Vault Escape never sends terminal input');

  assert.equal((await api('/cards?q=RENAMED_TOKEN')).total, 0, 'Vault keys are not library content');
  await click('.workspace-nav', 'Agent Canvas'); await open();
  await wait(`document.querySelector('.vault-panel')?.textContent.includes('RENAMED_TOKEN')`); await close();
  await click('.workspace-nav', 'Card box');
  const placed = app.snapshot().cardBox.placements[0];
  if (placed) {
    const node = `.react-flow__node-card[data-id="card-box-${placed.cardId}"]`;
    await ev(`document.querySelector(${JSON.stringify(node + ' [aria-label="Maximize card ' + placed.cardId + '"]')}).click()`);
    await wait(`!!document.querySelector(${JSON.stringify(node + ' .zettel-card.maximized')})`);
    assert.equal(await ev(`!!document.querySelector('.vault-floating-button, [aria-label="Open Vault controls"]')`), false, 'No floating Vault shortcut on maximized cards');
    assert.equal(await ev(`[...document.querySelectorAll('button')].some(b=>/Vault/.test(b.textContent)&&b.getClientRects().length>0)`), false, 'No visible Vault button while maximized');
    await ev(`document.querySelector(${JSON.stringify(node + ' [aria-label="Return card ' + placed.cardId + ' to whiteboard"]')}).click()`);
  }

  const ordinary = app.snapshot().cards.map(card => card.id).sort();
  await open(); await click('.vault-panel', 'Lock now'); await wait(`document.querySelector('.vault-state')?.textContent==='Locked'`);
  assert.equal(await ev(`[...document.querySelectorAll('.vault-panel button')].find(b=>b.textContent==='Reset Vault permanently').disabled`), true);
  await fill('.vault-panel', 'Type RESET VAULT', 'RESET VAULT'); await click('.vault-panel', 'Reset Vault permanently');
  await wait(`document.querySelector('.vault-panel')?.textContent.includes('Set up Vault')`);
  assert.deepEqual(app.snapshot().cards.map(card => card.id).sort(), ordinary); assert.deepEqual((await human('/entries')).entries, []);
  assert.deepEqual(app.snapshot().cardPlacements, placementsBefore);
  assert.deepEqual(memberships(), membershipBefore);
  assert.deepEqual(await api('/cards'), libraryBefore);
  await close();
  assert.equal(await ev(`window.vaultTerminal===document.querySelector('.card-box-agent-sidebar .xterm')`), true);
  assert.deepEqual(app.runtime.processes.get(boxAgentId).writes, writes);
  console.log('Management-only Vault browser passed: no cards/placements, unique multi-key entries, explicit reveal/edit, stale response fencing, per-key approvals, rename/delete/recreate, both workspaces/maximize, reset and unchanged library/terminal.');
}
