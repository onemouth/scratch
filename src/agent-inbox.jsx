import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function inboxSummary(value) {
  if (!value || (value.state !== 'active' && value.state !== 'unavailable')) {
    return { state: 'unavailable', count: null, revision: null, generation: null, reason: 'Inbox status is unavailable from this server.' };
  }
  return {
    state: value.state,
    count: Number.isInteger(value.count) && value.count >= 0 ? value.count : null,
    revision: Number.isInteger(value.revision) ? value.revision : null,
    generation: typeof value.generation === 'string' ? value.generation : null,
    reason: typeof value.reason === 'string' ? value.reason : '',
    previousUnconfirmed: value.previousUnconfirmed === true,
  };
}

function waitDuration(receivedAt, now) {
  if (!Number.isFinite(receivedAt)) return 'wait time unknown';
  const seconds = Math.max(0, Math.floor((now - receivedAt) / 1000));
  if (seconds < 60) return `${seconds}s waiting`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m waiting`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m waiting`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h waiting`;
}

function responseSummary(payload) {
  const value = payload?.summary && typeof payload.summary === 'object' ? payload.summary : payload;
  if (!value || (value.state !== 'active' && value.state !== 'unavailable') || !Number.isInteger(value.revision) ||
      (value.generation !== null && typeof value.generation !== 'string') ||
      (value.count !== null && (!Number.isInteger(value.count) || value.count < 0))) {
    throw new Error('Inbox returned a malformed summary.');
  }
  return {
    state: value.state,
    count: value.count,
    revision: value.revision,
    generation: value.generation,
    reason: typeof value.reason === 'string' ? value.reason : '',
    previousUnconfirmed: value.previousUnconfirmed === true,
  };
}

export function AgentInbox({ agentId, agentName, inbox }) {
  const summary = useMemo(() => inboxSummary(inbox), [inbox]);
  const summaryRef = useRef(summary);
  summaryRef.current = summary;
  const trigger = useRef(null);
  const dialog = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const [details, setDetails] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  const close = (restoreFocus = true) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      if (!rect.width || !rect.height) { close(false); return; }
      const margin = 8;
      const width = Math.min(360, innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.right - width, innerWidth - width - margin));
      const below = rect.bottom + 6;
      const preferredTop = below + 300 <= innerHeight ? below : rect.top - Math.min(420, innerHeight - margin * 2) - 6;
      // Resize/zoom can briefly leave the old anchor rectangle outside the new
      // viewport before React lays it out. Clamp rather than closing mid-resize.
      const top = Math.max(margin, Math.min(preferredTop, innerHeight - margin - Math.min(120, innerHeight - margin * 2)));
      const maxHeight = Math.max(0, Math.min(420, innerHeight - top - margin));
      setPosition(previous => previous && previous.left === left && previous.top === top && previous.width === width && previous.maxHeight === maxHeight
        ? previous : { left, top, width, maxHeight });
    };
    // A Canvas transform can move the anchor without resizing it. Follow only
    // while open; this is local geometry sampling, never inbox/network polling.
    let frame;
    const follow = () => { place(); frame = requestAnimationFrame(follow); };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    dialog.current?.querySelector('button')?.focus({ preventScroll: true });
    const outside = event => {
      if (!dialog.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, !!position]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    const requested = { revision: summary.revision, generation: summary.generation };
    setDetails(null);
    setStatus('loading');
    setError('');
    fetch(`/api/agents/${encodeURIComponent(agentId)}/inbox`, { signal: controller.signal })
      .then(async response => {
        let payload;
        try { payload = await response.json(); }
        catch { throw new Error(`Could not read inbox response (HTTP ${response.status}).`); }
        if (!response.ok) throw new Error(payload?.error || `Could not load inbox (HTTP ${response.status}).`);
        const returned = responseSummary(payload);
        const current = summaryRef.current;
        if (returned.revision !== requested.revision || returned.generation !== requested.generation ||
            current.revision !== requested.revision || current.generation !== requested.generation) {
          throw new Error('Inbox changed while it was loading. Waiting for the latest status.');
        }
        if (!Array.isArray(payload?.messages)) throw new Error('Inbox returned malformed message details.');
        if (payload.messages.some(message => !message || typeof message.messageId !== 'string' || !message.messageId ||
            typeof message.sourceId !== 'string' || typeof message.text !== 'string' || !Number.isFinite(message.receivedAt) ||
            (message.state !== 'pending' && message.state !== 'uncertain'))) {
          throw new Error('Inbox returned malformed message details.');
        }
        const messages = payload.messages.map(message => ({
          messageId: message.messageId,
          sourceId: message.sourceId,
          sourceName: typeof message.sourceName === 'string' && message.sourceName ? message.sourceName : (message.sourceId || 'Unknown sender'),
          text: message.text,
          receivedAt: message.receivedAt,
          state: message.state,
        }));
        if (returned.state === 'active' && returned.count !== messages.length) {
          throw new Error('Inbox message count did not match its summary.');
        }
        if (!active) return;
        setDetails({ summary: returned, messages });
        setStatus('ready');
      })
      .catch(fetchError => {
        if (!active || fetchError.name === 'AbortError') return;
        setDetails(null);
        setError(fetchError.message || 'Could not load inbox.');
        setStatus('error');
      });
    return () => { active = false; controller.abort(); };
  }, [agentId, open, summary.generation, summary.revision]);

  const count = summary.state === 'active' && summary.count !== null ? String(summary.count) : '?';
  const label = summary.state === 'active'
    ? `${agentName} pending inbox: ${summary.count === null ? 'unknown count' : `${summary.count} message${summary.count === 1 ? '' : 's'}`}`
    : `${agentName} inbox unavailable`;
  const displayedSummary = details?.summary || summary;

  return <>
    <button ref={trigger} type="button" className={`agent-inbox-trigger icon-btn nodrag nopan${summary.state === 'unavailable' ? ' unavailable' : ''}`}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={label}
      onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
      <span className="agent-inbox-count">{count}</span>
    </button>
    {open && position && createPortal(<section ref={dialog} className="agent-inbox-popover nodrag nopan nowheel" role="dialog" aria-label={`${agentName} pending inbox`} style={position}
      onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const targets = [...dialog.current.querySelectorAll('button, [tabindex="0"]')];
          const edge = event.shiftKey ? targets[0] : targets.at(-1);
          if (document.activeElement === edge) { event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0])?.focus({ preventScroll: true }); }
        }
      }}>
      <header><div><strong>Pending inbox</strong><small>{displayedSummary.count === null ? 'Count unknown' : `${displayedSummary.count} pending`}</small></div><button type="button" className="icon-btn" aria-label="Close pending inbox" onClick={() => close()}>×</button></header>
      {displayedSummary.previousUnconfirmed && <div className="agent-inbox-warning">A previous agent process closed with unresolved messages. They are not replayed here.</div>}
      {displayedSummary.state === 'unavailable' && <div className="agent-inbox-unavailable" role="status">Inbox unavailable{displayedSummary.reason ? `: ${displayedSummary.reason}` : '.'}</div>}
      <div className="agent-inbox-messages" aria-live="polite" tabIndex={0} aria-label="Pending messages">
        {status === 'loading' && <div className="agent-inbox-state">Loading pending messages…</div>}
        {status === 'error' && <div className="agent-inbox-state error" role="alert">{error}</div>}
        {status === 'ready' && details.messages.map(message => <article key={message.messageId} className={`agent-inbox-message ${message.state}`}>
          <div className="agent-inbox-message-meta"><strong title={message.sourceId || undefined}>{message.sourceName}</strong><span title={Number.isFinite(message.receivedAt) ? new Date(message.receivedAt).toLocaleString() : undefined}>{waitDuration(message.receivedAt, now)}</span></div>
          {message.state === 'uncertain' && <div className="agent-inbox-uncertain">Pending state unconfirmed</div>}
          <div className="agent-inbox-text" tabIndex={0} aria-label={`Message from ${message.sourceName}`}>{message.text}</div>
        </article>)}
        {status === 'ready' && details.summary.state === 'active' && details.messages.length === 0 && <div className="agent-inbox-state">{details.summary.previousUnconfirmed ? 'No current-process pending messages.' : 'No pending messages.'}</div>}
        {status === 'ready' && details.summary.state === 'unavailable' && details.messages.length === 0 && <div className="agent-inbox-state">Message details cannot be confirmed while the inbox is unavailable.</div>}
      </div>
    </section>, document.body)}
  </>;
}
