import { existsSync, statSync, createReadStream, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { storeMediaUpload, serveMedia } from './card-media-store.js';
import { serveInteractiveAsset } from './interactive-asset-store.js';
import { savedWorkdirs } from './session-workdirs.js';

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
export const reply = (res, status, value) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

// Origin/body/response/media/SSE handling only; domain mutations are delegated.
export function createHttpHandler({ port, allowedOrigin, snapshot, clients, sessionsRoot, getBackendUrl, apiGuide, getCards, mediaDirectory, operate, isUnavailable, broadcast, dist }) {
  const handler = async (req, res) => {
    const cards = getCards();
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (!allowedOrigin(req.headers.origin)) return reply(res, 403, { error: 'Cross-origin requests are not allowed' });
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return reply(res, 200, snapshot(true, { includeOutput: false }));
    if (url.pathname === '/api/session-workdirs' && req.method === 'GET') {
      try { return reply(res, 200, { workdirs: await savedWorkdirs(sessionsRoot) }); }
      catch (error) { return reply(res, 500, { error: error.message }); }
    }
    if (url.pathname === '/api/docs' && req.method === 'GET') {
      const backendUrl = getBackendUrl();
      // The web UI passes its own origin, since Vite may rewrite Host when proxying.
      const requestedOrigin = url.searchParams.get('origin');
      const canvasUrl = requestedOrigin && allowedOrigin(requestedOrigin) ? requestedOrigin : backendUrl;
      const guide = readFileSync(apiGuide, 'utf8').replaceAll('$AGENT_CANVAS_URL', canvasUrl);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(guide);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const controller = new AbortController();
      const disconnected = () => controller.abort();
      res.once('close', disconnected);
      try {
        if (isUnavailable()) return reply(res, 503, { error: 'Canvas is shutting down or resetting' });
        // Intent marker, NOT authentication: this loopback API has no auth model.
        // Browser gestures are unrestricted; ordinary API layout writes are checked.
        const humanLayout = req.headers['x-canvas-layout'] === 'human';
        const mediaSlot = url.pathname.match(/^\/api\/cards\/([^/]+)\/media\/(image|audio)$/);
        if (mediaSlot && req.method === 'PUT') {
          const [, id, kind] = mediaSlot;
          const expected = req.headers['if-match'] ?? null;
          cards.assertMediaSlot(id, kind, expected);
          const card = await storeMediaUpload(req, mediaDirectory, kind, req.headers['x-file-name'], file => {
            if (isUnavailable()) throw Object.assign(new Error('Canvas is shutting down or resetting'), { status: 503 });
            return cards.setMedia(id, kind, file, expected);
          });
          broadcast(); return reply(res, 200, card);
        }
        const mediaFile = url.pathname.match(/^\/api\/card-files\/([^/]+)$/);
        if (mediaFile && ['GET', 'HEAD'].includes(req.method)) return await serveMedia(req, res, mediaDirectory, cards.mediaFile(mediaFile[1]));
        const interactiveFile = url.pathname.match(/^\/api\/interactive-assets\/([^/]+)$/);
        if (interactiveFile && ['GET', 'HEAD'].includes(req.method)) return await serveInteractiveAsset(req, res, mediaDirectory, cards.interactiveAssetFile(interactiveFile[1]));
        let body = {};
        if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 16 * 1024 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
          }
          if (raw) body = JSON.parse(raw);
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected JSON object');
        }
        if (isUnavailable()) return reply(res, 503, { error: 'Canvas is shutting down or resetting' });
        const response = await operate({ path: url.pathname, method: req.method, body, query: url.searchParams, humanLayout, signal: controller.signal });
        return reply(res, response.status, response.value);
      } catch (error) {
        return reply(res, error.status || 400, { error: error.message, ...(error.code?.startsWith('LAYOUT_') ? { code: error.code, ...(error.conflicts ? { conflicts: error.conflicts } : {}), ...(error.object ? { object: error.object } : {}) } : {}) });
      } finally { res.removeListener('close', disconnected); }
    }
    if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
    const file = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(dist + '/') || !existsSync(file) || !statSync(file).isFile()) return reply(res, 404, { error: 'Run npm run build or npm run dev' });
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  return handler;
}
