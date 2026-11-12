// One public, bounded projection for both POSIX SHM and browser snapshots.
// Never include prompts, terminal output, tokens or session identity.
export function scoreboardRows(agents) {
  return agents.filter(agent => agent.workspace !== 'card-box' && agent.status === 'running')
    .map(agent => ({ id: agent.id, name: agent.name, generation: agent.processGeneration ?? null,
      status: ['working', 'idle'].includes(agent.activity) ? agent.activity : 'running',
      progress: agent.note ?? '', updatedAt: agent.scoreboardUpdatedAt ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
