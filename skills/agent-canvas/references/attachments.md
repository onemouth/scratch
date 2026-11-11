# Card attachments (human UI)

Each card has at most one image and one audio. `image` and `audio` are either `null` or `{id, kind, name, mime, size, createdAt, url}`. `name` is the original filename; `size` is bytes; `url` is a same-origin relative `/api/card-files/:id` URL, not an external URL or filesystem path. Attachments are independent of Markdown and do not count toward 400 text units. Normal card POST/PATCH cannot set these fields.

The browser supports dragging JPEG/PNG/WebP/GIF (10 MB) or MP3/M4A/WAV/OGG (50 MB) onto a card, not empty Canvas. It renders audio → image → text; metadata includes unlink controls. Switching Canvas preserves playback, and only one audio plays at a time.

Browser transport endpoints (not agent upload tools in this version):
- `PUT /api/cards/:id/media/image` or `/audio`: raw file bytes, with `X-File-Name` containing the URI-encoded original filename. Replacements require `If-Match` containing the current attachment UUID (unquoted). An empty slot must omit it. The slot is checked before and after streaming; stale replacements return 409. Successful uploads return the updated card, and SSE refreshes both modes.
- `DELETE /api/cards/:id/media/image` or `/audio` with `{"attachmentId":"<CURRENT_ATTACHMENT_UUID>"}`: unlink only, returning the updated card. A stale ID returns 409.
- `GET`/`HEAD /api/card-files/:id`: serve registered files using their actual detected MIME type, nosniff, immutable IDs and single byte-range support for seeking. Invalid ranges return 416. Missing files or byte-size mismatches return 404; oversized uploads return 413, unsupported formats 415, invalid names/empty files 400.

Files live in `images/` and `audios/` alongside SQLite. Replacing/unlinking attachments or permanently deleting cards **retains accepted file bytes and metadata** for a future audit; failed/uncommitted uploads are cleaned up. Stored ordinary attachment files have no audit/deletion API. Reset/removing a Canvas placement does not unlink attachments. Agents may read attachment metadata but must not use upload/unlink transport, write files directly into these directories, or alter attachment tables in this version.
