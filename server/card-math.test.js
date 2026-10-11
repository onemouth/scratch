import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './index.js';

test('card API stores math source and applies the same math-aware unit budget', async () => {
  const app = createApp({ port: 0, publicOrigin: null, spawnAgent() { throw Error('This test must not spawn Pi'); } });
  const request = async (path, method, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    await app.listen();
    const source = '$$\n\\frac{a}{b}\n$$';
    const created = await request('/cards', 'POST', { content: source });
    assert.equal(created.status, 201);
    assert.equal(created.data.content, source);
    assert.equal(created.data.units, 2);
    const path = '/cards/' + created.data.id;
    // Formula errors are rendering errors, not rejected card drafts.
    const malformed = '$\\frac{a}{$';
    assert.equal((await request(path, 'PATCH', { content: malformed })).data.content, malformed);
    const boundary = '$\\text{' + '中'.repeat(400) + '}$';
    const saved = await request(path, 'PATCH', { content: boundary });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.units, 400);
    assert.equal((await request(path, 'PATCH', { content: '$\\text{' + '中'.repeat(401) + '}$' })).status, 400);
    assert.equal((await request(path, 'PATCH', { content: '$' + ' '.repeat(20001) + '$' })).status, 400);
    assert.equal(app.snapshot().cards[0].content, boundary);
    assert.equal((await request(path, 'PATCH', { content: '<div>raw HTML</div>' })).status, 400);
    assert.equal((await request(path, 'PATCH', { content: '![image](image.png)' })).status, 400);
    assert.equal(app.snapshot().cards[0].content, boundary);
  } finally { await app.close(); }
});
