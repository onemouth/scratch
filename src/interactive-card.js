const assetPattern = /card-asset:\/\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})/g;

const escapeClosingTag = (value, tag) => value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');

export function usesInteractiveRuntime(card) {
  return Boolean(card.interactive?.javascript?.trim() || /@keyframes\b|(?:^|[;{])\s*animation(?:-[\w-]+)?\s*:/i.test(card.interactive?.css || ''));
}

export function replaceCardAssetUrls(value, urls) {
  return value.replace(assetPattern, (_match, name) => urls[name] || 'about:blank#missing-card-asset');
}

export function buildInteractiveDocument(card, urls, { run = false, nonce, token } = {}) {
  const html = replaceCardAssetUrls(card.interactive.html, urls);
  const css = replaceCardAssetUrls(card.interactive.css, urls);
  const javascript = replaceCardAssetUrls(card.interactive.javascript, urls);
  const paused = run ? '' : '*{animation-play-state:paused!important}';
  const assetSources = Object.values(urls).filter(url => /^https?:\/\//.test(url)).join(' ');
  const script = run ? `<script nonce="${nonce}">\n(() => {\nconst report = value => parent.postMessage({ type: 'agent-canvas-interactive-error', token: ${json(token)}, message: String(value).slice(0, 500) }, '*');\naddEventListener('error', event => report(event.error?.message || event.message || ('Could not load ' + (event.target?.tagName || 'interactive resource'))), true);\naddEventListener('unhandledrejection', event => report(event.reason?.message || event.reason || 'Unhandled promise rejection'));\ntry {\n${escapeClosingTag(javascript, 'script')}\n} catch (error) { report(error?.message || error); }\n})();\n</script>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob: data: ${assetSources}; media-src blob: data: ${assetSources}; connect-src ${assetSources || "'none'"}; font-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#interactive-root{width:100%;height:100%;margin:0;overflow:hidden}body{font-family:system-ui,sans-serif}${escapeClosingTag(css, 'style')}\n${paused}</style></head><body><div id="interactive-root">${html}</div>${script}</body></html>`;
}
