// Some node-pty macOS prebuilds ship spawn-helper without an executable bit.
import { existsSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'darwin') {
  const helper = join('node_modules', 'node-pty', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, statSync(helper).mode | 0o111);
  }
}
