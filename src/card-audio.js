export function createCardAudioController(createAudio) {
  let audio, generation = 0;
  const listeners = new Set();
  const empty = () => ({ fileId: null, playing: false, loading: false, time: 0, duration: 0, error: '' });
  let state = empty();
  const update = changes => { state = { ...state, ...changes }; for (const listener of listeners) listener(); };
  const ensure = () => {
    if (audio) return audio;
    audio = createAudio();
    audio.preload = 'metadata';
    audio.addEventListener('timeupdate', () => update({ time: Number.isFinite(audio.currentTime) ? audio.currentTime : 0 }));
    audio.addEventListener('loadedmetadata', () => update({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }));
    audio.addEventListener('durationchange', () => update({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 }));
    audio.addEventListener('ended', () => update({ playing: false, loading: false }));
    audio.addEventListener('error', () => { if (state.fileId) update({ playing: false, loading: false, error: 'Audio unavailable or unsupported by this browser.' }); });
    return audio;
  };
  const controller = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
    async toggle(file) {
      const element = ensure();
      if (state.fileId === file.id && (state.playing || state.loading)) {
        generation++; element.pause(); update({ playing: false, loading: false }); return;
      }
      const request = ++generation;
      if (state.fileId !== file.id) {
        element.pause();
        element.src = file.url;
        state = empty();
        update({ fileId: file.id, loading: true });
      } else if (state.error) {
        element.load();
        update({ loading: true, error: '', time: 0, duration: 0 });
      } else update({ loading: true, error: '' });
      try {
        await element.play();
        if (request === generation) update({ playing: true, loading: false });
      } catch {
        if (request === generation) update({ playing: false, loading: false, error: 'Unable to play audio. Try again or check the file format.' });
      }
    },
    seek(fileId, time) {
      if (state.fileId !== fileId || !audio || !Number.isFinite(time)) return;
      audio.currentTime = Math.max(0, Math.min(state.duration, time));
      update({ time: audio.currentTime });
    },
    reconcile(cards) {
      if (!state.fileId || cards.some(card => card.audio?.id === state.fileId)) return;
      generation++;
      audio?.pause();
      if (audio) { audio.removeAttribute('src'); audio.load(); }
      state = empty(); update({});
    },
  };
  return controller;
}

// One player shared by both Canvas representations; switching mode does not
// recreate it. Playback starts only in response to a user's button click.
export const cardAudio = createCardAudioController(() => new Audio());
export function audioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}
