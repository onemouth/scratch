import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './vault.css';

const VaultContext = createContext(null);
const CONTROL_PATTERN = /^[0-9a-f]{64}$/i;
const emptyControl = () => ({ entries: [], requests: [], grants: [] });

function consumeFragmentCode() {
  if (typeof window === 'undefined') return '';
  const match = location.hash.match(/(?:^#|[&#])vault-control=([^&]*)/);
  if (!match) return '';
  let code = '';
  try { code = decodeURIComponent(match[1]).trim(); } catch { /* Invalid fragments are discarded. */ }
  const kept = location.hash.slice(1).split('&').filter(part => part && !part.startsWith('vault-control=')).join('&');
  history.replaceState(history.state, '', location.pathname + location.search + (kept ? `#${kept}` : ''));
  return CONTROL_PATTERN.test(code) ? code : '';
}

let fragmentControlCode = consumeFragmentCode();

async function readJson(response) {
  let value;
  try { value = await response.json(); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('Invalid Vault response.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Vault response.');
  if (!response.ok) {
    const error = new Error(value.error || `HTTP ${response.status}`);
    error.code = value.code;
    error.status = response.status;
    throw error;
  }
  return value;
}

export function VaultProvider({ children }) {
  const [controlCode, setControlCode] = useState(() => {
    const code = fragmentControlCode;
    fragmentControlCode = '';
    return code;
  });
  const [status, setStatus] = useState({ configured: false, locked: true, instance: null, epoch: null, revision: 0 });
  const [control, setControl] = useState(emptyControl);
  const [controlConnected, setControlConnected] = useState(false);
  const [controlError, setControlError] = useState('');
  const [serverConnected, setServerConnectedState] = useState(false);
  const [secrets, setSecrets] = useState(() => new Map());
  const [panel, setPanel] = useState(null);
  const statusRef = useRef(status);
  const observationRef = useRef({ issued: 0, applied: { instance: null, revision: -1, token: 0 } });
  const controlBindingRef = useRef(controlCode ? 1 : 0);
  const controlCodeRef = useRef(controlCode);
  const localLockRef = useRef(false);
  const revealRef = useRef(new Map());
  statusRef.current = status;
  controlCodeRef.current = controlCode;
  const nextObservation = useCallback(() => ++observationRef.current.issued, []);

  const clearSecrets = useCallback(() => {
    for (const controller of revealRef.current.values()) controller.abort();
    revealRef.current.clear();
    setSecrets(new Map());
  }, []);
  const clearSecret = useCallback(entryId => {
    revealRef.current.get(entryId)?.abort();
    revealRef.current.delete(entryId);
    setSecrets(current => {
      if (!current.has(entryId)) return current;
      const next = new Map(current);
      next.delete(entryId);
      return next;
    });
  }, []);

  const adoptStatus = useCallback((next, token) => {
    if (!next || typeof next.locked !== 'boolean') return false;
    const incoming = { instance: next.instance ?? null, revision: Number.isFinite(next.revision) ? next.revision : 0, token };
    const applied = observationRef.current.applied;
    const sameInstance = incoming.instance === applied.instance;
    if ((sameInstance && incoming.revision < applied.revision) ||
        (sameInstance && incoming.revision === applied.revision && incoming.token < applied.token) ||
        (!sameInstance && incoming.token < applied.token) ||
        (localLockRef.current && !next.locked)) return false;
    observationRef.current.applied = incoming;
    const previous = statusRef.current;
    if (next.locked || previous.instance !== incoming.instance || previous.epoch !== next.epoch) clearSecrets();
    const value = {
      configured: !!next.configured,
      locked: !!next.locked,
      instance: incoming.instance,
      epoch: next.epoch,
      revision: incoming.revision,
    };
    statusRef.current = value;
    setStatus(value);
    return true;
  }, [clearSecrets]);
  const observeStatus = useCallback(next => adoptStatus(next, nextObservation()), [adoptStatus, nextObservation]);

  const privileged = useCallback(async (path, method = 'GET', body, signal) => {
    const code = controlCodeRef.current;
    const binding = controlBindingRef.current;
    if (!code) throw new Error('Connect with the Vault control code first.');
    const response = await fetch(`/api/vault${path}`, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', 'X-Vault-Control': code },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await readJson(response);
    if (binding !== controlBindingRef.current || code !== controlCodeRef.current) {
      const error = new Error('Vault control connection changed.');
      error.name = 'AbortError';
      throw error;
    }
    return value;
  }, []);

  const adoptControl = useCallback((next, token, binding) => {
    if (binding !== controlBindingRef.current) return false;
    const accepted = adoptStatus(next, token);
    const current = statusRef.current;
    const sameSnapshot = (next.instance ?? null) === current.instance && (Number.isFinite(next.revision) ? next.revision : 0) === current.revision;
    if (!accepted && !sameSnapshot) return false;
    setControl({ entries: next.entries || [], requests: next.requests || [], grants: next.grants || [] });
    setControlConnected(true);
    setControlError('');
    return true;
  }, [adoptStatus]);
  const refreshControl = useCallback(async signal => {
    const binding = controlBindingRef.current;
    const token = nextObservation();
    const next = await privileged('/control', 'GET', undefined, signal);
    adoptControl(next, token, binding);
    return next;
  }, [privileged, adoptControl, nextObservation]);

  useEffect(() => {
    let active = true;
    let controller;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      const token = nextObservation();
      try {
        const response = await fetch('/api/vault/status', { signal: controller.signal });
        const next = await readJson(response);
        if (active) adoptStatus(next, token);
      } catch (error) {
        if (active && error.name !== 'AbortError') clearSecrets();
      }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); controller?.abort(); };
  }, [adoptStatus, clearSecrets, nextObservation]);

  useEffect(() => {
    if (!controlCode) { setControlConnected(false); setControl(emptyControl()); return; }
    let active = true;
    const binding = controlBindingRef.current;
    let controller;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      const token = nextObservation();
      try {
        const next = await privileged('/control', 'GET', undefined, controller.signal);
        if (active) adoptControl(next, token, binding);
      } catch (error) {
        if (!active || binding !== controlBindingRef.current || error.name === 'AbortError') return;
        setControlConnected(false);
        setControlError(error.message);
        clearSecrets();
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => { active = false; clearInterval(timer); controller?.abort(); };
  }, [controlCode, privileged, adoptControl, clearSecrets, nextObservation]);

  useEffect(() => () => clearSecrets(), [clearSecrets]);

  const connectControl = useCallback(code => {
    const normalized = code.trim();
    if (!CONTROL_PATTERN.test(normalized)) throw new Error('The control code must be exactly 64 hexadecimal characters.');
    clearSecrets();
    controlBindingRef.current += 1;
    controlCodeRef.current = normalized;
    setControlError('');
    setControlConnected(false);
    setControlCode(normalized);
  }, [clearSecrets]);
  const disconnectControl = useCallback(() => {
    clearSecrets();
    controlBindingRef.current += 1;
    controlCodeRef.current = '';
    setControlCode('');
    setControlConnected(false);
    setControlError('');
    setControl(emptyControl());
  }, [clearSecrets]);
  const setServerConnected = useCallback(value => {
    setServerConnectedState(value);
    if (!value) clearSecrets();
  }, [clearSecrets]);

  const runStatusAction = useCallback(async (path, body) => {
    const token = nextObservation();
    const next = await privileged(path, 'POST', body);
    adoptStatus(next, token);
    return next;
  }, [privileged, adoptStatus, nextObservation]);
  const setup = useCallback(password => runStatusAction('/setup', { password }), [runStatusAction]);
  const unlock = useCallback(password => runStatusAction('/unlock', { password }), [runStatusAction]);
  const lock = useCallback(async () => {
    clearSecrets();
    localLockRef.current = true;
    const previous = statusRef.current;
    statusRef.current = { ...previous, locked: true };
    setStatus(statusRef.current);
    try { return await runStatusAction('/lock', {}); }
    finally { localLockRef.current = false; }
  }, [clearSecrets, runStatusAction]);
  const reset = useCallback(async () => {
    clearSecrets();
    const next = await runStatusAction('/reset', { confirmation: 'RESET VAULT' });
    setControl(emptyControl());
    return next;
  }, [clearSecrets, runStatusAction]);

  const reveal = useCallback(async entryId => {
    if (statusRef.current.locked) throw new Error('Unlock the Vault before revealing a value.');
    if (!serverConnected) throw new Error('Wait for the server connection before revealing a value.');
    revealRef.current.get(entryId)?.abort();
    const controller = new AbortController();
    revealRef.current.set(entryId, controller);
    const expectedInstance = statusRef.current.instance;
    const expectedEpoch = statusRef.current.epoch;
    try {
      const value = await privileged(`/entries/${encodeURIComponent(entryId)}/value`, 'GET', undefined, controller.signal);
      if (controller.signal.aborted || statusRef.current.locked || statusRef.current.instance !== expectedInstance || statusRef.current.epoch !== expectedEpoch || value.epoch !== expectedEpoch) throw new Error('Vault state changed before the value could be shown.');
      setSecrets(current => new Map(current).set(entryId, { key: value.key, value: value.value, epoch: value.epoch }));
      return value;
    } finally {
      if (revealRef.current.get(entryId) === controller) revealRef.current.delete(entryId);
    }
  }, [privileged, serverConnected]);

  const createEntry = useCallback(async draft => {
    const entry = await privileged('/entries', 'POST', { key: draft.key, value: draft.value });
    await refreshControl();
    return entry;
  }, [privileged, refreshControl]);
  const updateEntry = useCallback(async (id, draft, signal) => {
    const expectedInstance = statusRef.current.instance;
    const expectedEpoch = statusRef.current.epoch;
    const entry = await privileged(`/entries/${encodeURIComponent(id)}`, 'PATCH', { key: draft.key, value: draft.value }, signal);
    if (!signal?.aborted && !statusRef.current.locked && statusRef.current.instance === expectedInstance && statusRef.current.epoch === expectedEpoch) {
      setSecrets(current => new Map(current).set(id, { key: draft.key.trim(), value: draft.value, epoch: expectedEpoch }));
    }
    await refreshControl(signal);
    return entry;
  }, [privileged, refreshControl]);
  const deleteEntry = useCallback(async id => {
    clearSecret(id);
    const result = await privileged(`/entries/${encodeURIComponent(id)}`, 'DELETE', { confirm: true });
    await refreshControl();
    return result;
  }, [privileged, refreshControl, clearSecret]);
  const decide = useCallback(async (id, decision) => {
    await privileged(`/requests/${encodeURIComponent(id)}/decision`, 'POST', { decision });
    await refreshControl();
  }, [privileged, refreshControl]);
  const revoke = useCallback(async id => {
    await privileged(`/grants/${encodeURIComponent(id)}`, 'DELETE', {});
    await refreshControl();
  }, [privileged, refreshControl]);

  const value = {
    status, control, controlCode, controlConnected, controlError, serverConnected, secrets,
    connectControl, disconnectControl, setServerConnected, observeStatus, clearSecret,
    setup, unlock, lock, reset, reveal, createEntry, updateEntry, deleteEntry, decide, revoke,
    openPanel: section => setPanel(section || 'manage'), closePanel: () => setPanel(null), panel,
  };
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault() {
  const value = useContext(VaultContext);
  if (!value) throw new Error('VaultProvider is missing');
  return value;
}

function FocusDialog({ title, onClose, children }) {
  const root = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector('input, button')?.focus();
    const keyboard = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = [...(root.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])];
      const index = items.indexOf(document.activeElement);
      if (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault(); event.stopImmediatePropagation();
        (event.shiftKey ? items.at(-1) : items[0])?.focus();
      }
    };
    // A saved/deleted row may remove the focused input. Keep Escape/Tab in the
    // dialog even when the browser temporarily falls back to body focus.
    document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="overlay vault-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={root} className="modal vault-panel" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => event.stopPropagation()}>
      <div className="modal-head"><div><small>HUMAN CONTROL</small><h2>{title}</h2></div><button type="button" className="icon-btn" aria-label="Close Vault" onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>, document.body);
}

function VaultEntry({ entry, panelBusy }) {
  const vault = useVault();
  const secret = vault.secrets.get(entry.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ key: entry.key, value: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const operation = useRef(null);
  const actionSequence = useRef(0);
  const input = useRef(null);

  useEffect(() => {
    if (!secret) {
      actionSequence.current += 1;
      operation.current?.abort();
      operation.current = null;
      setEditing(false); setBusy(''); setError(''); setDraft({ key: entry.key, value: '' });
    }
  }, [secret, entry.key, vault.status.instance, vault.status.epoch, vault.status.locked, vault.controlConnected, vault.serverConnected]);
  useEffect(() => () => {
    actionSequence.current += 1;
    operation.current?.abort();
    vault.clearSecret(entry.id);
  }, [entry.id, vault.clearSecret]);
  useEffect(() => { if (!editing) setDraft({ key: entry.key, value: secret?.value || '' }); }, [entry.key, secret?.value, editing]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);

  const reveal = async () => {
    const sequence = ++actionSequence.current;
    setBusy('reveal'); setError('');
    try { await vault.reveal(entry.id); }
    catch (failure) { if (sequence === actionSequence.current && failure.name !== 'AbortError') setError(failure.message); }
    finally { if (sequence === actionSequence.current) setBusy(''); }
  };
  const cancel = () => {
    actionSequence.current += 1;
    operation.current?.abort(); operation.current = null;
    setEditing(false); setBusy(''); setError(''); setDraft({ key: entry.key, value: secret?.value || '' });
  };
  const hide = () => { cancel(); vault.clearSecret(entry.id); };
  const save = async event => {
    event.preventDefault();
    const sequence = ++actionSequence.current;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy('save'); setError('');
    try { await vault.updateEntry(entry.id, draft, controller.signal); if (sequence === actionSequence.current && !controller.signal.aborted) setEditing(false); }
    catch (failure) { if (sequence === actionSequence.current && failure.name !== 'AbortError') setError(failure.message); }
    finally { if (operation.current === controller) operation.current = null; if (sequence === actionSequence.current) setBusy(''); }
  };
  const remove = async () => {
    if (!confirm(`Permanently delete Vault key “${entry.key}”? This revokes its grants and cannot be undone.`)) return;
    const sequence = ++actionSequence.current;
    setBusy('delete'); setError('');
    try { await vault.deleteEntry(entry.id); }
    catch (failure) { if (sequence === actionSequence.current) { if (failure.name !== 'AbortError') setError(failure.message); setBusy(''); } }
  };
  const disabled = !!panelBusy || !!busy;

  return <li className="vault-entry" data-entry-id={entry.id}>
    {editing ? <form className="vault-entry-editor" autoComplete="off" onSubmit={save}>
      <label>Key name<input ref={input} required disabled={disabled} maxLength={120} value={draft.key} onChange={event => setDraft(current => ({ ...current, key: event.target.value }))} /></label>
      <label>Encrypted value<textarea required disabled={disabled} value={draft.value} onChange={event => setDraft(current => ({ ...current, value: event.target.value }))} /></label>
      <p>No autosave. Save explicitly to replace this key/value.</p>
      <div><button type="button" disabled={disabled} onClick={cancel}>Cancel</button><button className="primary" disabled={disabled} type="submit">{busy === 'save' ? 'Saving…' : 'Save key'}</button></div>
    </form> : <>
      <div className="vault-entry-head"><strong>{entry.key}</strong><span>{entry.updatedAt ? `Updated ${new Date(entry.updatedAt).toLocaleString()}` : ''}</span></div>
      {secret ? <><pre aria-label={`Revealed value for ${entry.key}`}>{secret.value}</pre><div className="vault-entry-actions"><button disabled={disabled || vault.status.locked} onClick={() => setEditing(true)}>Edit key…</button><button disabled={disabled} onClick={hide}>Hide value</button><button className="danger" disabled={disabled} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete key…'}</button></div></>
        : <div className="vault-entry-actions"><span className="vault-entry-concealed">Encrypted</span><button disabled={disabled || vault.status.locked || !vault.controlConnected || !vault.serverConnected} onClick={reveal}>{busy === 'reveal' ? 'Revealing…' : 'Reveal value'}</button><button className="danger" disabled={disabled} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete key…'}</button></div>}
      {error && <p className="node-error" role="alert">{error}</p>}
    </>}
  </li>;
}

export function VaultPanel() {
  const vault = useVault();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [resetText, setResetText] = useState('');
  const [draft, setDraft] = useState({ key: '', value: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const runRef = useRef(0);
  const displayRef = useRef(0);
  const panel = vault.panel;

  const clearLocal = useCallback((includeCode = false, includeBusy = false) => {
    if (includeCode) setCode('');
    setPassword(''); setConfirmation(''); setResetText(''); setDraft({ key: '', value: '' });
    if (includeBusy) setBusy('');
    setError(''); setMessage('');
  }, []);
  useEffect(() => {
    if (!panel) { runRef.current += 1; displayRef.current += 1; clearLocal(true, true); }
  }, [panel, clearLocal]);
  useEffect(() => {
    displayRef.current += 1;
    clearLocal(false, false);
  }, [vault.status.instance, vault.status.epoch, vault.status.locked, vault.controlConnected, vault.serverConnected, clearLocal]);
  if (!panel) return null;

  const closePanel = () => {
    runRef.current += 1; displayRef.current += 1;
    clearLocal(true, true);
    vault.closePanel();
  };
  const run = async (name, operation, success) => {
    const sequence = ++runRef.current;
    const display = displayRef.current;
    setBusy(name); setError(''); setMessage('');
    try {
      await operation();
      if (sequence !== runRef.current || display !== displayRef.current) return false;
      if (success) setMessage(success);
      return true;
    } catch (failure) {
      if (sequence === runRef.current && display === displayRef.current && failure.name !== 'AbortError') setError(failure.message);
      return false;
    } finally {
      if (sequence === runRef.current) setBusy('');
    }
  };
  const passwordAction = async event => {
    event.preventDefault();
    if (!vault.status.configured && password !== confirmation) { setError('Passwords do not match.'); return; }
    const settingUp = !vault.status.configured;
    const completed = await run(settingUp ? 'setup' : 'unlock', () => settingUp ? vault.setup(password) : vault.unlock(password), settingUp ? 'Vault created and unlocked.' : 'Vault unlocked.');
    if (completed) { setPassword(''); setConfirmation(''); }
  };
  const create = async event => {
    event.preventDefault();
    const completed = await run('create', () => vault.createEntry(draft), 'Key added.');
    if (completed) setDraft({ key: '', value: '' });
  };

  return <FocusDialog title="Vault" onClose={closePanel}>
    {!vault.controlCode ? <form onSubmit={event => {
      event.preventDefault();
      try { vault.connectControl(code); setCode(''); setError(''); } catch (failure) { setError(failure.message); }
    }}>
      <p className="vault-lead">Paste the ephemeral Vault control code printed in the <strong>Scratch backend server console</strong>. This is not your master password.</p>
      <p className="vault-note">The code stays only in this page’s memory. It is never stored. Agents cannot retrieve it from the public API.</p>
      <label>Vault control code<input autoFocus required autoComplete="off" spellCheck="false" value={code} onChange={event => setCode(event.target.value)} placeholder="64 hexadecimal characters" /></label>
      {error && <p className="node-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="primary" type="submit">Connect human control</button></div>
    </form> : <>
      <div className="vault-status-row"><span className={`vault-state ${vault.status.locked ? 'locked' : 'unlocked'}`}>{vault.status.locked ? 'Locked' : 'Unlocked'}</span><span>{vault.controlConnected ? 'Human control connected' : 'Checking control code…'}</span><button type="button" onClick={vault.disconnectControl}>Disconnect</button></div>
      {(vault.controlError || error) && <p className="node-error" role="alert">{error || vault.controlError}</p>}
      {message && <p className="vault-success" role="status">{message}</p>}

      {vault.controlConnected && <>
        {(!vault.status.configured || vault.status.locked) && <form className="vault-section" autoComplete="off" onSubmit={passwordAction}>
          <h3>{vault.status.configured ? 'Unlock Vault' : 'Set up Vault'}</h3>
          <p>{vault.status.configured ? 'Enter the master password. It is sent only for this explicit unlock.' : 'Choose a master password. RESET VAULT remains available if the password is forgotten.'}</p>
          <label>Master password<input type="password" required disabled={!!busy} minLength={vault.status.configured ? undefined : 8} maxLength={1024} autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} /></label>
          {!vault.status.configured && <label>Confirm master password<input type="password" required disabled={!!busy} minLength={8} maxLength={1024} autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
          <button className="primary" type="submit" disabled={!!busy}>{busy === 'unlock' || busy === 'setup' ? 'Working…' : vault.status.configured ? 'Unlock' : 'Create Vault'}</button>
        </form>}

        {vault.status.configured && !vault.status.locked && <>
          <div className="vault-section vault-lock-row"><div><h3>Vault is unlocked</h3><p>Each key is revealed only by explicit action. Locking clears every revealed value immediately.</p></div><button type="button" disabled={!!busy} onClick={() => run('lock', vault.lock, 'Vault locked.')}>{busy === 'lock' ? 'Locking…' : 'Lock now'}</button></div>
          <form className="vault-section vault-create" autoComplete="off" onSubmit={create}>
            <h3>New key</h3>
            <label>Key name<input required disabled={!!busy} maxLength={120} value={draft.key} onChange={event => setDraft(current => ({ ...current, key: event.target.value }))} /></label>
            <label>Encrypted value<textarea required disabled={!!busy} rows={4} value={draft.value} onChange={event => setDraft(current => ({ ...current, value: event.target.value }))} /></label>
            <p className="vault-note">Key names are exact, case-sensitive, and unique. No autosave or browser draft storage.</p>
            <button className="primary" type="submit" disabled={!!busy}>{busy === 'create' ? 'Adding…' : 'Add key'}</button>
          </form>
        </>}

        {vault.status.configured && <section className="vault-section" aria-labelledby="vault-entries-title"><h3 id="vault-entries-title">Keys</h3>
          {!vault.control.entries.length ? <p>No keys yet.</p> : <ul className="vault-entries">{vault.control.entries.map(entry => <VaultEntry key={entry.id} entry={entry} panelBusy={busy} />)}</ul>}
        </section>}

        <section className="vault-section" aria-labelledby="vault-requests-title"><h3 id="vault-requests-title">Pending requests</h3>
          {!vault.control.requests.length ? <p>None.</p> : <ul className="vault-list">{vault.control.requests.map(request => <li key={request.id}><div><strong>{request.key}</strong><span>{request.agentName || request.agentId} · {request.entryId}</span></div><div><button disabled={!!busy} onClick={() => run(`request-${request.id}`, () => vault.decide(request.id, 'once'))}>Allow once</button><button disabled={!!busy} onClick={() => run(`request-${request.id}`, () => vault.decide(request.id, 'process'))}>Allow process</button><button disabled={!!busy} onClick={() => run(`request-${request.id}`, () => vault.decide(request.id, 'deny'))}>Deny</button></div></li>)}</ul>}
        </section>
        <section className="vault-section" aria-labelledby="vault-grants-title"><h3 id="vault-grants-title">Process grants</h3><p>Each grant applies to one key and remains across lock/unlock until revoked or the process ends.</p>
          {!vault.control.grants.length ? <p>None.</p> : <ul className="vault-list">{vault.control.grants.map(grant => <li key={grant.id}><div><strong>{grant.key}</strong><span>{grant.agentName || grant.agentId} · {grant.entryId}</span></div><button disabled={!!busy} onClick={() => run(`grant-${grant.id}`, () => vault.revoke(grant.id))}>Revoke</button></li>)}</ul>}
        </section>
        <form className="vault-section vault-danger" onSubmit={async event => { event.preventDefault(); if (await run('reset', vault.reset, 'Vault reset. All keys, grants, and requests were deleted.')) setResetText(''); }}>
          <h3>Reset Vault</h3><p>Works even when locked or the master password is forgotten. Permanently deletes every key, grant, request, and the Vault configuration. Cards and views are unchanged.</p>
          <label>Type RESET VAULT<input value={resetText} autoComplete="off" onChange={event => setResetText(event.target.value)} /></label>
          <button type="submit" disabled={resetText !== 'RESET VAULT' || !!busy}>{busy === 'reset' ? 'Resetting…' : 'Reset Vault permanently'}</button>
        </form>
      </>}
    </>}
  </FocusDialog>;
}

