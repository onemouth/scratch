// Keep paste framing independent of xterm's replayed terminal modes.
export function terminalPaste(text) {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\x1b/g, '');
  return `\x1b[200~${normalized}\x1b[201~`;
}

export function pasteChunks(text) {
  const framed = terminalPaste(text);
  const chunks = [];
  // Stay below the terminal WebSocket input limit, without splitting UTF-16 pairs.
  for (let start = 0; start < framed.length;) {
    let end = Math.min(start + 32000, framed.length);
    if (end < framed.length && /[\uD800-\uDBFF]/.test(framed[end - 1])) end--;
    chunks.push(framed.slice(start, end));
    start = end;
  }
  return chunks;
}
