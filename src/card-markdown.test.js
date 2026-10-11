import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CardMarkdown } from './card-markdown.js';

const render = content => renderToStaticMarkup(createElement(CardMarkdown, { content }));

test('card Markdown renders inline and display math with accessible MathML', () => {
  const html = render('Energy $E=mc^2$.\n\n$$\n\\frac{a}{b} + \\sqrt{x}\n$$');
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.match(html, /encoding="application\/x-tex"/);
});

test('ordinary Markdown, literal code and escaped dollar amounts are preserved', () => {
  const html = render('# Heading\n\n**bold** [link](https://example.com)\n\n`$x$`\n\n```latex\n\\frac{a}{b}\n```\n\nPrices: \\$5 and \\$10.');
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com">link<\/a>/);
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.match(html, /class="language-latex"/);
  assert.match(html, /Prices: \$5 and \$10/);
  assert.doesNotMatch(html, /class="katex"/);
  assert.match(render(''), /<em>Empty card<\/em>/);
});

test('math fences render and malformed math remains readable without throwing', () => {
  assert.match(render('```math\n\\sum_{i=1}^n x_i\n```'), /katex-display/);
  const html = render('Before $\\frac{a}{$ after.');
  assert.match(html, /katex-error/);
  assert.match(html, /Before/);
  assert.match(html, /after/);
  assert.match(html, /\\frac\{a\}\{/);
});

test('math cannot create links, images or trusted HTML; raw HTML remains disabled', () => {
  for (const source of [
    '$\\href{https://example.com}{click}$',
    '$\\href{javascript:alert(1)}{click}$',
    '$\\includegraphics{https://example.com/image.png}$',
    '$\\htmlClass{injected}{x}$',
    '$\\htmlStyle{background:url(https://example.com/image.png)}{x}$',
    '$\\text{<script>alert(1)</script>}$',
    '<script>alert(1)</script>\n\n![image](https://example.com/image.png)',
  ]) {
    const html = render(source);
    assert.doesNotMatch(html, /<(?:a|img|script|iframe)\b/);
    assert.doesNotMatch(html, /class="injected"|<[^>]+style="[^"]*background:url/);
  }
});

test('recursive macro expansion is bounded and macros cannot leak between renders', () => {
  assert.match(render('$\\def\\loop{\\loop}\\loop$'), /katex-error/);
  assert.doesNotMatch(render('$\\gdef\\cardmacro{a}\\cardmacro$'), /katex-error/);
  assert.ok(render('$\\cardmacro$').includes('\\cardmacro</mtext>'));
});
