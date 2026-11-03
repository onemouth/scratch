// Explicit UI intent, not an authentication credential. Agents use ordinary API
// requests and must not set this header or acquire/release human gesture leases.
export const humanLayoutHeaders = { 'X-Canvas-Layout': 'human' };

export function createLayoutInteraction({ request, owner, onError = () => {}, schedule = setInterval, cancel = clearInterval }) {
  const ready = Promise.resolve().then(() => request({ owner, action: 'start' })).catch(onError);
  let ending = false, finished;
  let pending = ready;
  const timer = schedule(() => {
    // Serialize renewals, including slow requests, so an old renew cannot arrive
    // after release and resurrect a completed gesture's lease.
    pending = pending.then(() => ending ? undefined : request({ owner, action: 'renew' })).catch(onError);
  }, 3000);
  return (commit = async () => {}) => {
    if (finished) return finished;
    ending = true; cancel(timer);
    finished = (async () => {
      await pending;
      try { return await commit(); }
      finally { await request({ owner, action: 'end' }).catch(onError); }
    })();
    return finished;
  };
}

export const completeLayoutInteraction = (finish, commit) => finish ? finish(commit) : commit();

export function beginLayoutInteraction(kind, id, onError) {
  return createLayoutInteraction({ owner: crypto.randomUUID(), onError,
    request: async body => {
      const response = await fetch(`/api/canvas/layout-interactions/${kind}/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...humanLayoutHeaders }, body: JSON.stringify(body), keepalive: body.action === 'end',
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    },
  });
}
