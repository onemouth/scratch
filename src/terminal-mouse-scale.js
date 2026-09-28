// xterm.js 6 uses screen-space clientX/Y but unscaled CSS cell dimensions
// when selecting text. React Flow transforms the terminal at canvas zoom.
// Keep xterm's own mouse service responsible for clamping/cell rounding, but
// translate pointer coordinates back into the element's untransformed space.
export function unscalePointer(event, element) {
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width / element.offsetWidth;
  const scaleY = rect.height / element.offsetHeight;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return event;
  return {
    clientX: rect.left + (event.clientX - rect.left) / scaleX,
    clientY: rect.top + (event.clientY - rect.top) / scaleY,
  };
}

export function correctTerminalMouseScale(terminal) {
  // xterm.js does not currently expose its mouse coordinate service publicly.
  // This is confined to one adapter so it can be revisited when xterm changes.
  const mouse = terminal._core?._mouseService;
  if (!mouse?.getCoords || !mouse?.getMouseReportCoords) return false;
  const getCoords = mouse.getCoords.bind(mouse);
  const getMouseReportCoords = mouse.getMouseReportCoords.bind(mouse);
  mouse.getCoords = (event, element, ...rest) => getCoords(unscalePointer(event, element), element, ...rest);
  mouse.getMouseReportCoords = (event, element) => getMouseReportCoords(unscalePointer(event, element), element);
  return true;
}
