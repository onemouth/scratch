import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileTypeFromFile } from 'file-type';
import { MEDIA, MEDIA_ID } from '../shared/card-media.js';

const formats = {
  jpg: ['image', 'image/jpeg'], png: ['image', 'image/png'], webp: ['image', 'image/webp'], gif: ['image', 'image/gif'],
  mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'], wav: ['audio', 'audio/wav'],
  ogg: ['audio', 'audio/ogg'], oga: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'],
};
const failure = (message, status) => Object.assign(new Error(message), { status });
export function validateMediaFile(file) {
  if (!file || !MEDIA_ID.test(file.id) || !MEDIA[file.kind] || typeof file.name !== 'string' || !file.name.trim() || Buffer.byteLength(file.name) > 1024 || /[\/\\\x00-\x1f\x7f]/.test(file.name) ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MEDIA[file.kind].limit || !Number.isFinite(Date.parse(file.createdAt))) throw new Error('Invalid attachment metadata');
  const extension = file.filename?.slice(file.id.length + 1);
  const format = formats[extension];
  if (file.filename !== file.id + '.' + extension || !format || format[0] !== file.kind || format[1] !== file.mime) throw new Error('Invalid attachment filename or format');
  return file;
}
export function publicMediaFile(file) {
  validateMediaFile(file);
  const { filename, ...metadata } = file;
  return { ...metadata, url: '/api/card-files/' + file.id };
}
export async function initializeMedia(directory) {
  if (!directory) return;
  for (const value of Object.values(MEDIA)) await mkdir(join(directory, value.directory), { recursive: true, mode: 0o700 });
}

// Failed/uncommitted uploads are cleaned up. Successfully stored files are never
// removed by attachment replacement, unlinking, card deletion or Canvas reset.
export async function storeMediaUpload(req, directory, kind, encodedName, commit) {
  if (!directory) throw failure('Attachment storage requires a data directory', 503);
  let name;
  try { name = decodeURIComponent(encodedName || ''); } catch { throw failure('Invalid attachment filename', 400); }
  if (!name.trim() || Buffer.byteLength(name) > 1024 || /[\/\\\x00-\x1f\x7f]/.test(name)) throw failure('Invalid attachment filename', 400);
  const limit = MEDIA[kind].limit;
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw failure(`File exceeds ${limit / 1024 / 1024} MB`, 413); }
  const id = randomUUID(), folder = join(directory, MEDIA[kind].directory);
  const temporary = join(folder, id + '.upload');
  let handle, destination, accepted = false, size = 0;
  try {
    handle = await open(temporary, 'wx', 0o600);
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > limit) { req.resume(); throw failure(`File exceeds ${limit / 1024 / 1024} MB`, 413); }
      await handle.writeFile(chunk);
    }
    if (!size) throw failure('Empty attachment', 400);
    await handle.sync();
    await handle.close(); handle = null;
    let detected;
    try { detected = await fileTypeFromFile(temporary); } catch { throw failure('Invalid image or audio file', 415); }
    const format = formats[detected?.ext];
    if (!format || format[0] !== kind) throw failure('Unsupported or mismatched image/audio format', 415);
    const extension = ['oga', 'opus'].includes(detected.ext) ? 'ogg' : detected.ext;
    const file = validateMediaFile({ id, kind, name, size, mime: format[1], filename: id + '.' + extension, createdAt: new Date().toISOString() });
    destination = join(folder, file.filename);
    await rename(temporary, destination);
    // Flush the directory entry before committing its reference in SQLite.
    const folderHandle = await open(folder, 'r');
    try { await folderHandle.sync(); } finally { await folderHandle.close(); }
    const card = commit(file);
    accepted = true;
    return card;
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
    if (!accepted && destination) await rm(destination, { force: true });
  }
}

export async function serveMedia(req, res, directory, file) {
  validateMediaFile(file);
  if (!directory) throw failure('Attachment storage unavailable', 404);
  const path = join(directory, MEDIA[file.kind].directory, file.filename);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') throw failure('Attachment file not found', 404); throw error; }
  if (!info.isFile() || info.size !== file.size) throw failure('Attachment file missing or damaged', 404);
  const etag = '"' + file.id + '"';
  const headers = { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ETag: etag,
    'Cache-Control': 'private, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16)) };
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
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
