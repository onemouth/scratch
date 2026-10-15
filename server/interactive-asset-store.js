import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { fileTypeFromFile } from 'file-type';
import { INTERACTIVE_LIMITS, validateInteractiveAssetName } from './interactive-card.js';

const kinds = Object.freeze({ image: 'images', audio: 'audio', video: 'video' });
const formats = Object.freeze({
  jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], png: ['image', 'image/png'], webp: ['image', 'image/webp'], gif: ['image', 'image/gif'],
  mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'], wav: ['audio', 'audio/wav'], ogg: ['audio', 'audio/ogg'], oga: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'],
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'],
});
const assetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const inside = (root, path) => path.startsWith(root.endsWith(sep) ? root : root + sep);

export function validateInteractiveAssetFile(file) {
  validateInteractiveAssetName(file?.name);
  const extension = typeof file?.filename === 'string' ? file.filename.slice(file.id?.length + 1) : '';
  const format = formats[extension];
  if (!assetId.test(file?.id) || file.filename !== `${file.id}.${extension}` || !format || format[0] !== file.kind || format[1] !== file.mime ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > INTERACTIVE_LIMITS.assetBytes || !Number.isFinite(Date.parse(file.createdAt))) {
    throw new Error('Invalid interactive asset metadata');
  }
  return file;
}

export async function initializeInteractiveAssets(directory) {
  if (directory) await mkdir(join(directory, 'interactive-assets'), { recursive: true, mode: 0o700 });
}

export async function importInteractiveAsset({ cardId, kind, source, name, mediaRoot, directory, commit }) {
  if (!directory) fail('Interactive asset storage requires a data directory', 503);
  if (!kinds[kind]) fail('kind must be image, audio or video');
  validateInteractiveAssetName(name);
  if (typeof source !== 'string' || !source || source.includes('\0') || source.startsWith('/') || source.split(/[\\/]/).includes('..')) fail('source must be a safe relative path');
  const configuredRoot = join(mediaRoot, kinds[kind]);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  let root, input;
  try { root = await realpath(configuredRoot); input = await realpath(join(configuredRoot, source)); }
  catch (error) { if (error.code === 'ENOENT') fail('Source media file not found', 404); throw error; }
  if (!inside(root, input)) fail('Source media path escapes its allowed folder');
  const info = await lstat(input);
  if (!info.isFile()) fail('Source media path must be a regular file');
  if (info.size < 1 || info.size > INTERACTIVE_LIMITS.assetBytes) fail('Interactive asset must be non-empty and at most 25 MB', 413);
  const detected = await fileTypeFromFile(input);
  const format = formats[detected?.ext];
  if (!format || format[0] !== kind) fail(`Unsupported or mismatched ${kind} file`, 415);
  const id = randomUUID();
  const extension = detected.ext === 'jpeg' ? 'jpg' : ['oga', 'opus'].includes(detected.ext) ? 'ogg' : detected.ext;
  const filename = `${id}.${extension}`;
  const folder = join(directory, 'interactive-assets');
  const temporary = join(folder, `${id}.import`);
  const destination = join(folder, filename);
  let accepted = false;
  try {
    await copyFile(input, temporary);
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, destination);
    const folderHandle = await open(folder, 'r');
    try { await folderHandle.sync(); } finally { await folderHandle.close(); }
    const card = commit(validateInteractiveAssetFile({ id, cardId, name, kind, mime: format[1], size: info.size, filename, createdAt: new Date().toISOString() }));
    accepted = true; return card;
  } finally {
    await rm(temporary, { force: true });
    if (!accepted) await rm(destination, { force: true });
  }
}

export async function removeInteractiveAssetFile(directory, filename) {
  if (directory && typeof filename === 'string' && basename(filename) === filename) await rm(join(directory, 'interactive-assets', filename), { force: true });
}

export async function serveInteractiveAsset(req, res, directory, file) {
  validateInteractiveAssetFile(file);
  if (!directory) fail('Interactive asset storage unavailable', 404);
  const path = join(directory, 'interactive-assets', file.filename);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') fail('Interactive asset file not found', 404); throw error; }
  if (!info.isFile() || info.size !== file.size) fail('Interactive asset file missing or damaged', 404);
  const etag = `"${file.id}"`;
  const headers = { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', ETag: etag, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' };
  if (!req.headers.range && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
