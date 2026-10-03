import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
const words = new Intl.Segmenter('en', { granularity: 'word' });
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const CARD_LIMIT = 600;

// Count rendered text, never Markdown syntax or link destinations.
export function inspectCardContent(content) {
  if (typeof content !== 'string' || content.length > 20000) throw new Error('content must be a string of at most 20000 source characters');
  const tree = parser.parse(content);
  let rendered = '';
  function visit(node) {
    if (['html', 'image', 'imageReference'].includes(node.type)) throw new Error('Cards support text Markdown only; images and raw HTML are not allowed');
    if (['text', 'code', 'inlineCode'].includes(node.type)) {
      rendered += node.value;
    }
    for (const child of node.children || []) visit(child);
    if (['paragraph', 'heading', 'code', 'listItem', 'break', 'thematicBreak'].includes(node.type)) rendered += ' ';
  }
  visit(tree);
  let units = 0, nonCjk = '';
  for (const { segment } of graphemes.segment(rendered)) {
    if (cjk.test(segment)) { units++; nonCjk += ' '; }
    else nonCjk += segment;
  }
  for (const segment of words.segment(nonCjk)) if (segment.isWordLike) units++;
  return units;
}
export function validateCardContent(content) {
  const units = inspectCardContent(content);
  if (units > CARD_LIMIT) throw new Error('content exceeds 600 text units (CJK characters + English words)');
  return units;
}
