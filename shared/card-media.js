export const MEDIA = {
  image: { directory: 'images', limit: 10 * 1024 * 1024, extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] },
  audio: { directory: 'audios', limit: 50 * 1024 * 1024, extensions: ['mp3', 'm4a', 'wav', 'ogg'] },
};
export const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function mediaKind(file) {
  const mime = file.type?.toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) return 'image';
  if (['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/vnd.wave', 'audio/ogg', 'audio/opus'].includes(mime)) return 'audio';
  const extension = file.name?.split('.').pop().toLowerCase();
  return Object.entries(MEDIA).find(([, value]) => value.extensions.includes(extension))?.[0] ?? null;
}
export function mediaDropFiles(files) {
  const result = [];
  const seen = new Set();
  for (const file of files) {
    const kind = mediaKind(file);
    if (!kind) throw new Error('Use JPEG, PNG, WebP, GIF, MP3, M4A, WAV or OGG files.');
    if (seen.has(kind)) throw new Error('Drop at most one image and one audio file at a time.');
    if (!file.size || file.size > MEDIA[kind].limit) throw new Error(`${kind === 'image' ? 'Image' : 'Audio'} must be non-empty and at most ${MEDIA[kind].limit / 1024 / 1024} MB.`);
    seen.add(kind); result.push({ kind, file });
  }
  return result;
}
