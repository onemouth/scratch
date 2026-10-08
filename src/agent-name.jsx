import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function AgentName({ id, name, onError }) {
  const [position, setPosition] = useState(null);
  const menu = useRef(null);
  const copyButton = useRef(null);
  const previousFocus = useRef(null);
  const openMenu = (event, x, y) => {
    event.preventDefault();
    event.stopPropagation();
    previousFocus.current = document.activeElement;
    setPosition({ x, y });
  };
  const closeAndRestoreFocus = () => {
    setPosition(null);
    if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!position) return;
    copyButton.current?.focus({ preventScroll: true });
    const outside = event => { if (!menu.current?.contains(event.target)) setPosition(null); };
    const dismiss = () => setPosition(null);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('wheel', dismiss, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('wheel', dismiss);
    };
  }, [position]);
  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
      onError('');
    } catch {
      onError(`Could not copy agent ${label}. Clipboard access requires localhost or HTTPS and browser permission.`);
    }
    closeAndRestoreFocus();
  };
  return <>
    <strong title={`${name}\nRight-click to copy agent name or UUID`} tabIndex={0} aria-haspopup="menu" aria-expanded={!!position}
      onContextMenu={event => openMenu(event, event.clientX, event.clientY)}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(event, rect.left, rect.bottom);
        }
      }}>{name}</strong>
    {position && createPortal(<div ref={menu} className="agent-name-menu nodrag nopan" role="menu" aria-label="Agent copy actions"
      style={{ left: Math.max(8, Math.min(position.x, innerWidth - 188)), top: Math.max(8, Math.min(position.y, innerHeight - 80)) }}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onFocus={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={event => {
        // Portals still bubble React events through the owning node. Menu keys
        // must not move/select/delete a node or become terminal input.
        event.stopPropagation();
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const items = [...menu.current.querySelectorAll('[role="menuitem"]')];
          const index = items.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }
        if (['ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
        if (event.key === 'Escape') { event.preventDefault(); closeAndRestoreFocus(); }
        if (event.key === 'Tab') setPosition(null);
      }}>
      <button ref={copyButton} type="button" role="menuitem" onClick={() => copy(name, 'name')}>Copy agent name</button>
      <button type="button" role="menuitem" onClick={() => copy(id, 'UUID')}>Copy agent UUID</button>
    </div>, document.body)}
  </>;
}
