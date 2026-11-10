import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { newVault, openVault, seal, unseal, valueAAD, validateVaultKey } from './vault-crypto.js';

export const vaultError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const digest = value => createHash('sha256').update(value).digest();
// Human and process credentials are separate capabilities, never Canvas metadata.
// This avoids accidental/model-driven self-approval; not a hostile same-UID sandbox.
export function createVault({ cards, getAgent, onChange = () => {}, requestTimeout = 120000, now = Date.now }) {
  const control = randomBytes(32).toString('hex'), controlHash = digest(control), instance = randomUUID();
  const processes = new Map(), requests = new Map(), grants = new Map();
  let key = null, epoch = randomUUID(), revision = 0, closed = false, passwordBusy = false, passwordAfter = 0;
  const status = () => ({ configured: !!cards.vaultConfig(), locked: !key, instance, epoch, revision });
  const changed = (newEpoch = false) => { if (newEpoch) epoch = randomUUID(); revision++; onChange(); };
  const checkOpen = () => { if (closed) throw vaultError('VAULT_UNAVAILABLE', 'Vault is closed', 503); };
  const unlocked = () => { checkOpen(); if (!key) throw vaultError('VAULT_LOCKED', 'Unlock the Vault in Scratch first', 423); };
  const validProcess = process => {
    const agent = getAgent(process.agentId);
    if (!process.active || !agent || agent.status !== 'running' || agent.processGeneration !== process.generation) throw vaultError('VAULT_GENERATION', 'Agent process is no longer current', 409);
    return agent;
  };
  function authenticate(token) {
    checkOpen();
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw vaultError('VAULT_CALLER', 'A current Agent Vault credential is required', 403);
    const process = processes.get(digest(token).toString('hex'));
    if (!process) throw vaultError('VAULT_CALLER', 'A current Agent Vault credential is required', 403);
    validProcess(process); return process;
  }
  function finish(request, error, value) {
    if (!requests.delete(request.id)) return;
    clearTimeout(request.timer); request.signal?.removeEventListener('abort', request.abort);
    if (error) request.reject(error); else request.resolve(value);
    changed();
  }
  function cancelWhere(predicate, code, message) {
    for (const request of [...requests.values()]) if (predicate(request)) finish(request, vaultError(code, message, 409));
  }
  function lock() {
    checkOpen();
    key?.fill(0); key = null;
    cancelWhere(() => true, 'VAULT_LOCKED', 'Vault was locked'); changed(true);
    return status();
  }
  const crypto = {
    encryptVault(id, name, value) { unlocked(); return seal(key, Buffer.from(value), valueAAD(id, name)); },
    decryptVault(id, name, envelope) {
      unlocked(); const bytes = unseal(key, envelope, valueAAD(id, name));
      try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
    },
  };
  function reveal(id) {
    unlocked(); const entry = cards.vaultEntry(id);
    return { id, key: entry.key, value: crypto.decryptVault(id, entry.key, cards.vaultEnvelope(id)), epoch };
  }
  async function passwordOperation(password, setup) {
    checkOpen();
    if (passwordBusy || now() < passwordAfter) throw vaultError('VAULT_BUSY', 'Wait before another password attempt', 429);
    const config = cards.vaultConfig();
    if (setup && config) throw vaultError('VAULT_CONFIGURED', 'Vault is already configured', 409);
    if (!setup && !config) throw vaultError('VAULT_NOT_CONFIGURED', 'Set up the Vault first', 409);
    if (!setup && key) throw vaultError('VAULT_UNLOCKED', 'Vault is already unlocked', 409);
    const original = epoch; passwordBusy = true;
    let result;
    try {
      result = setup ? await newVault(password) : { key: await openVault(password, config) };
      checkOpen();
      if (epoch !== original) throw vaultError('VAULT_CHANGED', 'Vault changed while unlocking; try again', 409);
      if (setup) cards.initializeVault(result.config);
      key = result.key; result = null; passwordAfter = 0; changed(true);
      return status();
    } catch (error) { passwordAfter = now() + 1000; throw error; }
    finally { result?.key?.fill(0); passwordBusy = false; }
  }
  function observeProcesses() {
    let dirty = false;
    for (const [token, process] of processes) {
      try { validProcess(process); } catch {
        processes.delete(token); process.active = false;
        cancelWhere(request => request.process === process, 'VAULT_GENERATION', 'Agent process ended');
        for (const [id, grant] of grants) if (grant.process === process) { grants.delete(id); dirty = true; }
      }
    }
    if (dirty) changed();
  }
  function details() {
    checkOpen(); observeProcesses();
    const describe = record => {
      const { agentId, generation } = record.process, agent = validProcess(record.process), entry = cards.vaultEntry(record.entryId);
      return { id: record.id, entryId: entry.id, key: entry.key, agentId, agentName: agent.name, generation,
        ...(record.createdAt !== undefined ? { createdAt: record.createdAt, expiresAt: record.expiresAt } : {}) };
    };
    return { ...status(), entries: cards.vaultEntries(), requests: [...requests.values()].map(describe), grants: [...grants.values()].map(describe) };
  }
  return {
    // Only the application startup console / isolated tests receive this value.
    controlCode: control,
    status, details, lock, observeProcesses,
    authorizeProcess: authenticate,
    authorizeControl(value) {
      checkOpen();
      if (typeof value !== 'string' || value.length !== 64 || !timingSafeEqual(digest(value), controlHash)) throw vaultError('VAULT_CONTROL', 'Enter the Vault control code from the Scratch server console', 403);
    },
    openProcess(agentId, generation) {
      checkOpen();
      const token = randomBytes(32).toString('hex'), tokenHash = digest(token).toString('hex'), process = { agentId, generation, active: true };
      processes.set(tokenHash, process);
      return { token, close() {
        process.active = false;
        if (!processes.delete(tokenHash)) return;
        cancelWhere(request => request.process === process, 'VAULT_GENERATION', 'Agent process ended');
        for (const [id, grant] of grants) if (grant.process === process) grants.delete(id);
        changed();
      } };
    },
    setup: password => passwordOperation(password, true),
    unlock: password => passwordOperation(password, false),
    reveal,
    entries() { checkOpen(); return cards.vaultEntries(); },
    create(body) {
      unlocked();
      if (cards.vaultEntries().length >= 256) throw vaultError('VAULT_CAPACITY', 'Vault supports at most 256 keys', 409);
      const entry = cards.createVaultEntry(body, crypto);
      changed(); return entry;
    },
    update(id, body) {
      unlocked(); const previous = cards.vaultEntry(id), entry = cards.updateVaultEntry(id, body, crypto);
      if (entry.key !== previous.key) {
        cancelWhere(request => request.entryId === id, 'VAULT_KEY_CHANGED', 'Vault key was renamed; request approval again');
        for (const [grantId, grant] of grants) if (grant.entryId === id) grants.delete(grantId);
      }
      changed(); return entry;
    },
    remove(id, confirm) {
      checkOpen(); if (confirm !== true) throw vaultError('VAULT_CONFIRM', 'Deletion requires confirm: true');
      cards.deleteVaultEntry(id);
      cancelWhere(request => request.entryId === id, 'VAULT_DELETED', 'Vault key was deleted');
      for (const [grantId, grant] of grants) if (grant.entryId === id) grants.delete(grantId);
      changed(); return { ok: true };
    },
    reset(confirmation) {
      checkOpen(); if (confirmation !== 'RESET VAULT') throw vaultError('VAULT_CONFIRM', 'Type RESET VAULT to delete all Vault data');
      // Commit durable deletion before changing in-memory state. Historical backups
      // and SQLite free pages are not securely erased; no such claim is made.
      cards.resetVault();
      key?.fill(0); key = null;
      cancelWhere(() => true, 'VAULT_RESET', 'Vault was reset'); grants.clear(); passwordAfter = 0;
      changed(true); return status();
    },
    retrieve(token, name, signal) {
      const process = authenticate(token); unlocked();
      const entry = cards.vaultEntryByKey(validateVaultKey(name)), entryId = entry.id;
      if (signal?.aborted) throw vaultError('VAULT_CANCELLED', 'Vault request cancelled', 499);
      const requestedEpoch = epoch;
      const checkDelivery = grantId => {
        unlocked(); validProcess(process);
        if (epoch !== requestedEpoch) throw vaultError('VAULT_CHANGED', 'Vault changed before retrieval completed', 409);
        if (signal?.aborted) throw vaultError('VAULT_CANCELLED', 'Vault request cancelled', 499);
        if (grantId && !grants.has(grantId)) throw vaultError('VAULT_REVOKED', 'Vault grant was revoked before retrieval completed', 409);
        if (cards.vaultEntry(entryId).key !== entry.key) throw vaultError('VAULT_KEY_CHANGED', 'Vault key changed before retrieval completed', 409);
      };
      const grant = [...grants.values()].find(grant => grant.process === process && grant.entryId === entryId);
      if (grant) return Promise.resolve().then(() => { checkDelivery(grant.id); return reveal(entryId).value; });
      if (requests.size >= 64 || [...requests.values()].filter(request => request.process === process).length >= 8) throw vaultError('VAULT_CAPACITY', 'Too many pending Vault requests', 429);
      let request;
      return new Promise((resolve, reject) => {
        request = { id: randomUUID(), process, entryId, createdAt: now(), expiresAt: now() + requestTimeout, resolve, reject, signal };
        request.abort = () => finish(request, vaultError('VAULT_CANCELLED', 'Vault request cancelled', 499));
        request.timer = setTimeout(() => finish(request, vaultError('VAULT_EXPIRED', 'Vault approval request expired', 408)), requestTimeout);
        request.timer.unref?.();
        requests.set(request.id, request); signal?.addEventListener('abort', request.abort, { once: true }); changed();
      }).then(value => {
        checkDelivery(request.grantId);
        return value;
      });
    },
    decide(id, decision) {
      checkOpen();
      if (!['once', 'process', 'deny'].includes(decision)) throw vaultError('VAULT_DECISION', 'Choose once, process or deny');
      const request = requests.get(id);
      if (!request) throw vaultError('VAULT_REQUEST', 'Request is no longer pending', 409);
      if (now() >= request.expiresAt) { finish(request, vaultError('VAULT_EXPIRED', 'Vault approval request expired', 408)); throw vaultError('VAULT_EXPIRED', 'Request expired', 409); }
      try { validProcess(request.process); }
      catch (error) { finish(request, error); throw error; }
      if (decision === 'deny') finish(request, vaultError('VAULT_DENIED', 'Vault access was denied', 403));
      else {
        unlocked(); const value = reveal(request.entryId).value;
        let grant;
        if (decision === 'process') {
          grant = [...grants.values()].find(grant => grant.process === request.process && grant.entryId === request.entryId);
          if (!grant) { grant = { id: randomUUID(), process: request.process, entryId: request.entryId }; grants.set(grant.id, grant); }
        }
        // A process grant also authorizes its already-waiting requests, without
        // granting another key/process access or prompting repeatedly for one key.
        for (const pending of [...requests.values()]) if (pending === request || (grant && pending.process === request.process && pending.entryId === request.entryId)) {
          pending.grantId = grant?.id;
          finish(pending, null, value);
        }
      }
      return { ok: true };
    },
    revoke(id) {
      checkOpen(); const grant = grants.get(id);
      if (!grant) throw vaultError('VAULT_GRANT', 'Grant not found', 404);
      grants.delete(id);
      cancelWhere(request => request.process === grant.process && request.entryId === grant.entryId, 'VAULT_REVOKED', 'Vault grant revoked');
      changed(); return { ok: true };
    },
    close() {
      if (closed) return;
      key?.fill(0); key = null; closed = true;
      cancelWhere(() => true, 'VAULT_UNAVAILABLE', 'Vault is shutting down'); grants.clear(); processes.clear();
    },
  };
}
