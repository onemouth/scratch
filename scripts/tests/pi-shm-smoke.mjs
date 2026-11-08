import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCanvasMemory } from '../../server/canvas-memory.js';

const directory = await mkdtemp(join(tmpdir(), 'canvas-memory-pi-'));
const state = { agents: [{ id: 'isolated-fixture', name: 'Memory fixture', status: 'running', activity: 'working', processGeneration: 'fixture-generation' }],
  edges: [], notes: [], cards: [], cardPlacements: [] };
const publisher = createCanvasMemory({ getState: () => state });
const notifier = publisher.createNotifier();
let child, timeout, stderr = '';
try {
  child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--extension', fileURLToPath(new URL('../../server/pi-canvas-memory.js', import.meta.url)),
    '--extension', fileURLToPath(new URL('./pi-shm-extension.js', import.meta.url))], {
    cwd: directory,
    env: { ...process.env, PI_CODING_AGENT_DIR: directory, AGENT_CANVAS_URL: '', AGENT_CANVAS_ID: '',
      AGENT_CANVAS_SHM_NAME: publisher.name, AGENT_CANVAS_SHM_EPOCH: publisher.epoch, AGENT_CANVAS_SHM_NOTIFY: notifier.name },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    let buffer = '', read = false, handled = false, notified = false, notifyHandled = false, sentSubscribe = false;
    timeout = setTimeout(() => reject(new Error(`Pi smoke timed out: ${stderr}`)), 15000);
    child.once('error', reject);
    child.once('exit', (code, signal) => { if (!read || !handled || !notified || !notifyHandled) reject(new Error(`Pi exited early (${code}/${signal}): ${stderr}`)); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          assert.notEqual(event.type, 'agent_start', 'Diagnostic must not start an LLM run');
          if (event.type === 'extension_ui_request' && event.message?.startsWith('SHM_SMOKE:')) {
            const result = JSON.parse(event.message.slice('SHM_SMOKE:'.length));
            assert.equal(result.isError, undefined);
            const snapshot = JSON.parse(result.content[0].text);
            assert.equal(snapshot.source, 'posix-shared-memory');
            assert.equal(snapshot.sections.agents.items[0].id, 'isolated-fixture');
            read = true;
          }
          if (event.type === 'response' && event.id === 'smoke') {
            assert.equal(event.success, true, event.error);
            assert.equal(event.data.disposition, 'handled'); handled = true;
          }
          if (event.type === 'extension_ui_request' && event.message === 'SHM_SUBSCRIBED') {
            state.agents[0] = { ...state.agents[0], activity: 'idle' }; publisher.observeAgents();
          }
          if (event.type === 'extension_ui_request' && event.message?.startsWith('SHM_NOTIFY:')) {
            const notification = JSON.parse(event.message.slice('SHM_NOTIFY:'.length));
            assert.equal(notification.type, 'idle'); assert.equal(notification.agentId, 'isolated-fixture');
            notified = true;
          }
          if (event.type === 'extension_ui_request' && event.message?.startsWith('SHM_NOTIFY_ERROR:')) throw new Error(event.message);
          if (event.type === 'response' && event.id === 'notify') {
            assert.equal(event.success, true, event.error); assert.equal(event.data.disposition, 'handled'); notifyHandled = true;
          }
          if (read && handled && !sentSubscribe) {
            sentSubscribe = true;
            child.stdin.write(JSON.stringify({ id: 'notify', type: 'prompt', message: '/notify-smoke' }) + '\n');
          }
          if (read && handled && notified && notifyHandled) resolve();
        } catch (error) { reject(error); }
      }
    });
    child.stdin.write(JSON.stringify({ id: 'smoke', type: 'prompt', message: '/memory-smoke' }) + '\n');
  });
  clearTimeout(timeout);
  const exit = once(child, 'exit'); child.stdin.end();
  timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exit;
  console.log('Real Pi loaded Canvas tools, read SHM with HTTP forbidden, and received an idle event via semaphore notification. No LLM run or saved session.');
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  publisher.close(); await rm(directory, { recursive: true, force: true });
}
