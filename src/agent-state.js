// Show a successful human launch immediately, independently of SSE delivery.
// If SSE arrived first, retain its newer status/activity instead of replacing it
// with an older POST response, and never create a duplicate node.
export function includeCreatedAgent(state, agent) {
  if (state.agents.some(existing => existing.id === agent.id)) return state;
  return { ...state, agents: [...state.agents, agent] };
}
