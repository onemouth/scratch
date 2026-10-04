import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { cardAudio, audioTime } from './card-audio.js';
import { mediaDropFiles } from '../shared/card-media.js';

export function CardAudio({ file }) {
  const state = useSyncExternalStore(cardAudio.subscribe, cardAudio.getSnapshot, cardAudio.getSnapshot);
  const active = state.fileId === file.id;
  const playing = active && state.playing, loading = active && state.loading;
  const time = active ? state.time : 0, duration = active ? state.duration : 0;
  return <div className="card-audio nodrag nowheel nopan">
    <button type="button" aria-label={playing || loading ? 'Pause card audio' : 'Play card audio'} title={file.name} onClick={() => cardAudio.toggle(file)}>{playing || loading ? '❚❚' : '▶'}</button>
    <input type="range" aria-label="Audio playback position" min="0" max={duration || 1} step="0.1" value={Math.min(time, duration || 1)} disabled={!duration} onChange={event => cardAudio.seek(file.id, Number(event.target.value))} />
    <span>{audioTime(time)} / {duration ? audioTime(duration) : '—'}</span>
    {active && state.error && <small role="alert">{state.error}</small>}
  </div>;
}
function ImagePreview({ file, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div ref={dialog} className="card-image-preview" role="dialog" aria-modal="true" aria-label="Image preview" tabIndex={-1} onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose(); if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector('button').focus(); } }}>
    <button type="button" aria-label="Close image preview" onClick={onClose}>×</button>
    <img src={file.url} alt={file.name} />
  </div>, document.body);
}
export function CardImage({ file }) {
  const [open, setOpen] = useState(false), [failed, setFailed] = useState(false);
  if (failed) return <div className="card-media-error" role="alert">Image unavailable: {file.name}</div>;
  return <>
    <button type="button" className="card-image nodrag" aria-label="Enlarge card image" onClick={() => setOpen(true)}><img src={file.url} alt={file.name} draggable={false} loading="lazy" onError={() => setFailed(true)} /></button>
    {open && <ImagePreview file={file} onClose={() => setOpen(false)} />}
  </>;
}
export function CardAttachmentInfo({ card, onRemove, busy }) {
  return <>{['audio', 'image'].map(kind => {
    const file = card[kind];
    return <React.Fragment key={kind}><dt>{kind === 'audio' ? 'Audio' : 'Image'}</dt><dd>{file ? <>
      <span>{file.name} · {Math.max(1, Math.round(file.size / 1024))} KB</span>
      <button type="button" className="card-media-remove" aria-label={`Remove card ${kind}`} disabled={busy} onClick={() => onRemove(kind, file)}>Remove</button>
    </> : '—'}</dd></React.Fragment>;
  })}</>;
}
export function useCardUpload(card) {
  const [status, setStatus] = useState({ busy: false, error: '', message: '' });
  const [dropping, setDropping] = useState(false);
  const busy = useRef(false), depth = useRef(0), controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const perform = async action => {
    if (busy.current) return;
    busy.current = true; controller.current = new AbortController();
    setStatus({ busy: true, error: '', message: 'Saving attachment…' });
    try { await action(controller.current.signal); setStatus({ busy: false, error: '', message: '' }); }
    catch (error) { if (error.name !== 'AbortError') setStatus({ busy: false, error: error.message, message: '' }); }
    finally { busy.current = false; controller.current = null; }
  };
  const files = event => event.dataTransfer?.types?.includes('Files');
  const dropProps = {
    onDragEnter(event) { if (!files(event)) return; event.preventDefault(); event.stopPropagation(); depth.current++; setDropping(true); },
    onDragLeave(event) { if (!depth.current) return; event.stopPropagation(); if (--depth.current <= 0) { depth.current = 0; setDropping(false); } },
    onDragOver(event) { if (!files(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy.current ? 'none' : 'copy'; },
    onDrop(event) {
      if (!files(event)) return;
      event.preventDefault(); event.stopPropagation(); depth.current = 0; setDropping(false);
      if (busy.current) return;
      let uploads;
      try { uploads = mediaDropFiles([...event.dataTransfer.files]); }
      catch (error) { setStatus({ busy: false, error: error.message, message: '' }); return; }
      if (!uploads.length) return;
      for (const { kind } of uploads) if (card[kind] && !confirm(`Replace the existing ${kind} attachment? The old file will be retained for a future audit.`)) return;
      perform(async signal => {
        for (const { kind, file } of uploads) {
          setStatus({ busy: true, error: '', message: `Uploading ${kind}…` });
          const headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) };
          if (card[kind]) headers['If-Match'] = card[kind].id;
          const response = await fetch('/api/cards/' + card.id + '/media/' + kind, { method: 'PUT', headers, body: file, signal });
          if (!response.ok) throw new Error((await response.json()).error || 'Upload failed');
        }
      });
    },
  };
  const remove = (kind, file) => {
    if (!confirm(`Remove this ${kind} from the card? The stored file will be retained for a future audit.`)) return;
    perform(async signal => {
      const response = await fetch('/api/cards/' + card.id + '/media/' + kind, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attachmentId: file.id }), signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Removal failed');
    });
  };
  return { dropProps, dropping, status, remove };
}
