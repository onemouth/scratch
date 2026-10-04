export function parsePublicOrigin(value) {
  if (value == null || value === '') return null;
  const invalid = () => new Error('AGENT_CANVAS_PUBLIC_ORIGIN must be one HTTPS origin without credentials, a path, query, fragment or wildcard');
  if (typeof value !== 'string' || !/^https:\/\/[^/?#@\\\s]+\/?$/i.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes('*')) throw invalid();
  return url.origin;
}
