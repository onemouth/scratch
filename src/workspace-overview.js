// Bounds include only the active workspace and its visible viewport.
// CSS-invisible nodes must not participate: they stay mounted for terminal continuity.
export function workspaceOverview(nodes, workspace, viewport, width, height) {
  const visible = nodes.filter(node => node.data.workspace === workspace);
  const view = { x: -viewport.x / viewport.zoom, y: -viewport.y / viewport.zoom, width: width / viewport.zoom, height: height / viewport.zoom };
  let left = view.x, top = view.y, right = view.x + view.width, bottom = view.y + view.height;
  const rectangles = visible.map(node => {
    const rect = { id: node.id, node, x: node.position.x, y: node.position.y, width: node.measured?.width ?? node.width ?? node.style?.width ?? 0, height: node.measured?.height ?? node.height ?? node.style?.height ?? 0 };
    left = Math.min(left, rect.x); top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width); bottom = Math.max(bottom, rect.y + rect.height);
    return rect;
  });
  // Fixed 200:150 aspect ratio prevents letterboxing from affecting pointer mapping.
  const scale = Math.max((right - left) / 180, (bottom - top) / 130, 1);
  const bounds = { x: (left + right) / 2 - 100 * scale, y: (top + bottom) / 2 - 75 * scale, width: 200 * scale, height: 150 * scale };
  return { rectangles, view, bounds };
}
