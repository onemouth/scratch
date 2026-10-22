// Import as text: JSXGraph executes only inside the card's sandbox, never in Canvas.
// Vite packages this lazy chunk locally; no CDN or runtime package loading is allowed.
// Relative paths intentionally select the prebuilt distribution (package exports
// expose only its source entry point, which must not execute in the parent).
import javascript from '../node_modules/jsxgraph/distrib/jsxgraphcore.js?raw';
import css from '../node_modules/jsxgraph/distrib/jsxgraph.css?raw';
import license from '../node_modules/jsxgraph/LICENSE.MIT?raw';

// Use JessieCode's interpreter: its default compiler uses eval and cannot run
// under the card CSP (even function graphs internally use the identity string).
export const jsxgraph = {
  javascript: `/* ${license} */\n${javascript}\nJXG.Options.jc.compile = false;\nJXG.Options.board.renderer = 'svg';\nJXG.Options.text.useMathJax = false;\nJXG.Options.text.useKatex = false;`,
  css,
};
