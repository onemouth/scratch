import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './scoreboard.css';

export function Scoreboard({ rows, connected, hidden, open, setOpen, onShow, onNavigate }) {
  const root = useRef(null), trigger = useRef(null), panel = useRef(null);
  useEffect(() => { if (hidden) setOpen(false); }, [hidden, setOpen]);
  useEffect(() => {
    if (!open || hidden) return;
    panel.current?.focus();
    const outside = event => {
      if (!root.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      setOpen(false); trigger.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, hidden, setOpen]);
  if (hidden) return null;
  return <div className="scoreboard" ref={root}>
    <button ref={trigger} type="button" className="guide-button" aria-expanded={open} aria-controls="scoreboard-panel" onClick={() => { if (!open) onShow(); setOpen(value => !value); }}>Board</button>
    {open && createPortal(<section id="scoreboard-panel" className="scoreboard-panel" ref={panel} role="dialog" aria-label="Board" tabIndex={-1}>
      <header><strong>Board</strong><span>Agent Canvas</span><button type="button" className="icon-btn" aria-label="Close Board" onClick={() => { setOpen(false); trigger.current?.focus(); }}>×</button></header>
      {!connected && <p className="scoreboard-unavailable" role="status">Disconnected · waiting for live updates</p>}
      <div className="scoreboard-columns" aria-hidden="true"><span>Agent</span><span>Status</span><span>Progress</span></div>
      <ul>
        {rows.map(row => <li key={row.id}><button type="button" className="scoreboard-row" data-agent-id={row.id} disabled={!connected} onClick={() => { setOpen(false); onNavigate(row.id, row.generation); }}>
          <span className="scoreboard-name" title={row.name}>{row.name}</span>
          <span className={`scoreboard-status ${row.status}`}>{row.status}</span>
          <span className="scoreboard-progress" title={row.progress}>{row.progress}</span>
        </button></li>)}
      </ul>
      {!rows.length && <p className="scoreboard-empty">No running Agent Canvas agents.</p>}
    </section>, document.body)}
  </div>;
}
