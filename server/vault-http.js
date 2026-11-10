import { vaultError } from './vault.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
function fields(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw vaultError('VAULT_FIELDS', 'Unexpected Vault request fields');
}
export function createVaultHttp({ getVault, isUnavailable }) {
  return async (req, res, url) => {
    const vault = getVault();
    try {
      if (!vault || isUnavailable()) throw vaultError('VAULT_UNAVAILABLE', 'Vault is unavailable', 503);
      if (url.search) throw vaultError('VAULT_FIELDS', 'Vault API does not accept query parameters');
      const path = url.pathname, method = req.method;
      if (path === '/api/vault/status' && method === 'GET') return json(res, 200, vault.status());
      if (path === '/api/vault/entries' && method === 'GET') return json(res, 200, { entries: vault.entries() });
      // Authenticate before reading a potentially large body / allocating a waiter.
      const retrieve = path === '/api/vault/retrieve' && method === 'POST';
      if (!retrieve) vault.authorizeControl(req.headers['x-vault-control']);
      const token = retrieve ? req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] : null;
      if (retrieve) vault.authorizeProcess(token);
      let body = {};
      if (['POST', 'PATCH', 'DELETE'].includes(method)) {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw vaultError('VAULT_CONTENT_TYPE', 'Expected application/json', 415);
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 256 * 1024) throw vaultError('VAULT_CAPACITY', 'Vault request is too large', 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
        catch { throw vaultError('VAULT_JSON', 'Invalid JSON object'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw vaultError('VAULT_JSON', 'Expected JSON object');
      }
      if (isUnavailable()) throw vaultError('VAULT_UNAVAILABLE', 'Vault is unavailable', 503);
      if (retrieve) {
        fields(body, ['key']);
        if (typeof body.key !== 'string') throw vaultError('VAULT_KEY', 'Expected a Vault key name');
        const abort = new AbortController();
        const disconnect = () => { if (!res.writableEnded) abort.abort(); };
        res.once('close', disconnect);
        try {
          const value = await vault.retrieve(token, body.key, abort.signal);
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); res.end(value);
          }
        } finally { res.removeListener('close', disconnect); }
        return;
      }
      if (path === '/api/vault/control' && method === 'GET') return json(res, 200, vault.details());
      if (path === '/api/vault/setup' && method === 'POST') { fields(body, ['password']); return json(res, 200, await vault.setup(body.password)); }
      if (path === '/api/vault/unlock' && method === 'POST') { fields(body, ['password']); return json(res, 200, await vault.unlock(body.password)); }
      if (path === '/api/vault/lock' && method === 'POST') { fields(body, []); return json(res, 200, vault.lock()); }
      if (path === '/api/vault/reset' && method === 'POST') { fields(body, ['confirmation']); return json(res, 200, vault.reset(body.confirmation)); }
      if (path === '/api/vault/entries' && method === 'POST') {
        fields(body, ['key', 'value']); return json(res, 201, vault.create(body));
      }
      const entry = path.match(/^\/api\/vault\/entries\/([a-zA-Z0-9-]{1,80})(\/value)?$/);
      if (entry) {
        const [, id, action] = entry;
        if (action && method === 'GET') return json(res, 200, vault.reveal(id));
        if (!action && method === 'PATCH') { fields(body, ['key', 'value']); return json(res, 200, vault.update(id, body)); }
        if (!action && method === 'DELETE') { fields(body, ['confirm']); return json(res, 200, vault.remove(id, body.confirm)); }
      }
      const decision = path.match(/^\/api\/vault\/requests\/([a-f0-9-]+)\/decision$/);
      if (decision && method === 'POST') { fields(body, ['decision']); return json(res, 200, vault.decide(decision[1], body.decision)); }
      const grant = path.match(/^\/api\/vault\/grants\/([a-f0-9-]+)$/);
      if (grant && method === 'DELETE') { fields(body, []); return json(res, 200, vault.revoke(grant[1])); }
      throw vaultError('VAULT_ROUTE', 'Unknown Vault operation', 404);
    } catch (error) {
      // Never serialize request bodies, credentials, crypto internals or stack traces.
      const known = error.code?.startsWith('VAULT_');
      json(res, error.status ?? 400, { error: known ? error.message : 'Vault operation failed', ...(error.code?.startsWith('VAULT_') ? { code: error.code } : {}) });
    }
  };
}
