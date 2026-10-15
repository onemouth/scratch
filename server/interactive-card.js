export const INTERACTIVE_LIMITS = Object.freeze({
  titleCharacters: 120,
  htmlBytes: 250 * 1024,
  cssBytes: 100 * 1024,
  javascriptBytes: 2 * 1024 * 1024,
  assetBytes: 25 * 1024 * 1024,
  totalAssetBytes: 100 * 1024 * 1024,
});

const bytes = value => Buffer.byteLength(value, 'utf8');
const sourceField = (value, name, limit) => {
  if (typeof value !== 'string' || bytes(value) > limit) throw new Error(`${name} must be a string of at most ${limit} UTF-8 bytes`);
  return value;
};

export function validateInteractiveTitle(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > INTERACTIVE_LIMITS.titleCharacters || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`title must contain 1–${INTERACTIVE_LIMITS.titleCharacters} characters without control characters`);
  }
  return value.trim();
}

export function validateInteractiveSource({ html, css = '', javascript = '' }) {
  html = sourceField(html, 'html', INTERACTIVE_LIMITS.htmlBytes);
  css = sourceField(css, 'css', INTERACTIVE_LIMITS.cssBytes);
  javascript = sourceField(javascript, 'javascript', INTERACTIVE_LIMITS.javascriptBytes);
  if (!html.trim()) throw new Error('html must not be empty');
  if (/<\s*script\b/i.test(html)) throw new Error('Put JavaScript in the javascript field; script elements are not allowed in html');
  if (/<\s*style\b/i.test(html)) throw new Error('Put CSS in the css field; style elements are not allowed in html');
  if (/<\s*(?:base|iframe|object|embed|link|meta|form)\b/i.test(html)) throw new Error('html contains an element that is not allowed in the interactive sandbox');
  if (/<\s*(?:audio|video)\b[^>]*\bautoplay\b/i.test(html)) throw new Error('audio and video autoplay are not allowed');
  const urlAttribute = /\b(?:src|href|poster|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(urlAttribute)) {
    const value = (match[1] ?? match[2] ?? match[3]).trim().toLowerCase();
    if (!value.startsWith('card-asset://') && !value.startsWith('data:') && !value.startsWith('#')) throw new Error('html resource URLs must use card-asset://, data: or a local #fragment');
  }
  return { html, css, javascript };
}

export function validateInteractiveAssetName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)) {
    throw new Error('asset name must contain 1–120 letters, numbers, dots, underscores or hyphens');
  }
  return value;
}
