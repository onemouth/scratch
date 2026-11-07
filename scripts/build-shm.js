import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--if-enabled') && process.env.AGENT_CANVAS_SHARED_MEMORY === '0') {
  console.log('Canvas shared memory disabled; skipping native build.');
  process.exit(0);
}
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Shared-memory prototype supports macOS/Linux only');
const root = fileURLToPath(new URL('..', import.meta.url));
const headers = resolve(dirname(process.execPath), '..');
const args = ['node_modules/node-gyp/bin/node-gyp.js', 'rebuild', '--directory', 'native/canvas-shm'];
// Prefer matching locally installed headers; otherwise node-gyp downloads the
// running Node version's headers normally. Never silently skip a failed build.
if (!process.env.npm_config_nodedir && existsSync(resolve(headers, 'include/node/node_api.h'))) args.push(`--nodedir=${headers}`);
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
