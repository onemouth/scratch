export function validateCardLinks(links) {
  if (!Array.isArray(links) || links.length > 100 || links.some(id => typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d{4,}$/.test(id.trim()))) throw new Error('Links must be up to 100 card IDs in YYYY-MM-DD-0001 format');
  return [...new Set(links.map(id => id.trim()))];
}
