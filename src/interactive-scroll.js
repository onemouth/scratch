// Some browsers route wheel input to the iframe element instead of its document
// when the card is inside a transformed canvas. Forward only those parent-side
// events; wheels delivered natively inside the iframe must not be handled twice.
export function forwardInteractiveWheel(event, frame, token) {
  if (!frame || event.target !== frame || event.ctrlKey || !frame.contentWindow) return false;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return false;
  event.preventDefault();
  event.stopPropagation();
  frame.contentWindow.postMessage({
    type: 'agent-canvas-interactive-wheel', token,
    x: (event.clientX - rect.left) * frame.clientWidth / rect.width,
    y: (event.clientY - rect.top) * frame.clientHeight / rect.height,
    deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
  }, '*');
  return true;
}

// Self-contained: serialized into the opaque-origin iframe, including before
// Play. This trusted UI plumbing does not load/evaluate authored code or grant
// parent/API access. The parent sends pointer/delta data, not instructions.
export function installInteractiveScrollBridge(token) {
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || data?.type !== 'agent-canvas-interactive-wheel' || data.token !== token ||
        ![data.x, data.y, data.deltaX, data.deltaY].every(Number.isFinite) || ![0, 1, 2].includes(data.deltaMode)) return;
    const x = Math.max(0, Math.min(innerWidth - 1, data.x));
    const y = Math.max(0, Math.min(innerHeight - 1, data.y));
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    // Preserve in-card wheel handlers (e.g. a plot's own zoom). Synthetic wheel
    // events have no native scrolling default, so scroll explicitly afterwards.
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: x, clientY: y, deltaX: data.deltaX, deltaY: data.deltaY, deltaMode: data.deltaMode });
    if (!target.dispatchEvent(wheel)) return;
    for (let node = target; node; node = node.parentElement) {
      if (typeof node.scrollBy !== 'function') continue;
      const style = getComputedStyle(node);
      const dx = /auto|scroll|overlay/.test(style.overflowX) ? data.deltaX : 0;
      const dy = /auto|scroll|overlay/.test(style.overflowY) ? data.deltaY : 0;
      if (!dx && !dy) continue;
      const unitX = data.deltaMode === 1 ? 16 : data.deltaMode === 2 ? node.clientWidth : 1;
      const unitY = data.deltaMode === 1 ? 16 : data.deltaMode === 2 ? node.clientHeight : 1;
      const beforeX = node.scrollLeft, beforeY = node.scrollTop;
      node.scrollBy({ left: Math.max(-4096, Math.min(4096, dx * unitX)), top: Math.max(-4096, Math.min(4096, dy * unitY)), behavior: 'instant' });
      if (node.scrollLeft !== beforeX || node.scrollTop !== beforeY) return;
    }
  });
}
