import { createElement, memo } from 'react';
import Markdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

const remarkPlugins = [remarkMath];
const rehypePlugins = [[rehypeKatex, {
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 10,
  errorColor: '#a12323',
}]];

// Zoom, viewport resize and streamed agent updates change ancestors, not math.
export const CardMarkdown = memo(function CardMarkdown({ content, preview = false }) {
  return createElement(Markdown, {
    skipHtml: true,
    disallowedElements: preview ? ['img', 'a'] : ['img'],
    unwrapDisallowed: preview,
    remarkPlugins,
    rehypePlugins,
  }, content || '*Empty card*');
});
