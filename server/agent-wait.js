const failure = (message, status) => Object.assign(new Error(message), { status });

// Subscribe and check synchronously, independently of coalesced SSE snapshots.
// Run identity is internal and never returned to the caller.
export function waitForAgent({ id, timeoutMs = 60000 }, { getAgent, getRun, subscribe, signal, isClosing = () => false }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw failure('timeoutMs must be an integer from 1 to 600000', 400);
  const original = getAgent(id);
  if (!original) throw failure('Agent not found', 404);
  const run = getRun(id);
  return new Promise((resolve, reject) => {
    let done = false, timer, unsubscribe = () => {}, last = original;
    const cleanup = () => { clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort); };
    const finish = reason => {
      if (done) return; done = true; cleanup();
      resolve({ id, reason, status: last.status, activity: last.activity });
    };
    const fail = error => { if (done) return; done = true; cleanup(); reject(error); };
    const abort = () => fail(failure('Caller disconnected', 499));
    const check = () => {
      if (isClosing()) { fail(failure('Canvas is shutting down', 503)); return; }
      const current = getAgent(id);
      if (!current) { finish('removed'); return; }
      if (['stopped', 'stopping'].includes(current.status)) { last = current; finish('stopped'); return; }
      if (getRun(id) !== run) { finish('stopped'); return; }
      last = current;
      if (current.activity === 'idle') finish('idle');
    };
    unsubscribe = subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    check();
  });
}
