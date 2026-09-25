import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalPaste, pasteChunks } from './terminal-paste.js';

test('multiline paste is framed once without submitting', () => {
  assert.equal(terminalPaste('one\r\ntwo\rthree'), '\x1b[200~one\ntwo\nthree\x1b[201~');
  assert.equal(terminalPaste('text\x1b[201~'), '\x1b[200~text[201~\x1b[201~');
});

test('large pastes fit WebSocket limits and preserve Unicode', () => {
  const text = 'abc🙂\n'.repeat(20000);
  const chunks = pasteChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), terminalPaste(text));
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 32000);
    assert.equal(Buffer.from(chunk).toString(), chunk);
  }
});
