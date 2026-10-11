// Preserve React Flow measurements on metadata-only updates; new sizes must be measured again.
export const nodeMeasurement = (old, width, height) => old?.style?.width === width && old?.style?.height === height ? old.measured : undefined;

// HTTP mutation replies are partial; SSE is authoritative across backend epochs.
export function mergeViewResponse(state, cardBox) {
  const current = state.cardBox;
  if ((current?.epoch && current.epoch !== cardBox.epoch) || current?.revision > cardBox.revision) return state;
  return { ...state, cardBox };
}
export function mergeViewSnapshot(state, next) {
  const current = state.cardBox, incoming = next.cardBox;
  if (current?.epoch === incoming?.epoch && current?.revision > incoming?.revision) return { ...next, cardBox: current };
  return next;
}
