// Show a successful human launch immediately, independently of SSE delivery.
// If SSE arrived first, retain its newer status/activity instead of replacing it
// with an older POST response, and never create a duplicate node.
// Explicit API-positioned launches should not steal the human's viewport/focus.
export const agentsToFocus = added => added?.filter(agent => !agent.suppressAutoFocus) || [];

export function includeCreatedAgent(state, agent) {
  if (state.agents.some(existing => existing.id === agent.id)) return state;
  return { ...state, agents: [...state.agents, agent] };
}
