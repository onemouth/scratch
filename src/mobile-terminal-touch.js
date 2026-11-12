// Keep glyphs aligned to terminal rows. Double swipe sensitivity without
// translating the rendered screen or simulating browser momentum.
export const HISTORY_SWIPE_SPEED = 2;
export function attachTerminalTouchScroll(viewport, terminal, onScroll) {
  let touch = null;
  const start = event => {
    const point = event.touches[0];
    touch = event.touches.length === 1 ? { id: point.identifier, x: point.clientX, y: point.clientY, axis: null, remainder: 0 } : null;
  };
  const move = event => {
    if (!touch || event.touches.length !== 1) { touch = null; return; }
    const point = event.touches[0];
    if (point.identifier !== touch.id) { touch = null; return; }
    const dx = point.clientX - touch.x, dy = touch.y - point.clientY;
    if (!touch.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      touch.axis = Math.abs(dy) > Math.abs(dx) ? 'vertical' : 'horizontal';
    }
    if (touch.axis !== 'vertical') return;
    event.preventDefault(); event.stopPropagation();
    const prior = viewport.scrollTop;
    viewport.scrollTop += dy;
    const remaining = (dy - (viewport.scrollTop - prior)) * HISTORY_SWIPE_SPEED + touch.remainder;
    const height = parseFloat(terminal.element.querySelector('.xterm-screen')?.style.height) / terminal.rows || 18;
    const lines = Math.trunc(remaining / height);
    if (lines) terminal.scrollLines(lines);
    touch.remainder = remaining - lines * height;
    touch.x = point.clientX; touch.y = point.clientY; onScroll();
  };
  const end = () => { touch = null; };
  viewport.addEventListener('touchstart', start, { capture: true, passive: true });
  viewport.addEventListener('touchmove', move, { capture: true, passive: false });
  viewport.addEventListener('touchend', end, true);
  viewport.addEventListener('touchcancel', end, true);
  return () => {
    viewport.removeEventListener('touchstart', start, true);
    viewport.removeEventListener('touchmove', move, true);
    viewport.removeEventListener('touchend', end, true);
    viewport.removeEventListener('touchcancel', end, true);
  };
}
