// A completion is a turn transition, never an initial snapshot or a stopped process.
export function completedAgents(previous, agents) {
  if (!previous) return [];
  return agents.filter(agent => agent.status === 'running' && previous.get(agent.id) === 'working' && agent.activity === 'idle');
}
