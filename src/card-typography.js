// Browser viewport CSS pixels, not physical screen resolution or devicePixelRatio.
export function cardTypography(width, zoom = 1) {
  const viewportWidth = Number.isFinite(width) ? width : 1440;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const progress = Math.max(0, Math.min(1, (viewportWidth - 1024) / (1440 - 1024)));
  const base = 11 + 2 * progress;
  const minimum = 10 + progress;
  return { base, minimum, fontSize: Math.max(base, minimum / scale) };
}

export function viewportWidth() {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

export function subscribeViewportWidth(notify) {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
}
