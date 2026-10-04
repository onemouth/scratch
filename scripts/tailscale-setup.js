import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configKeys = new Set(['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value == null || (object(value) && Object.keys(value).length === 0);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function setupOptions(args) {
  let apply = false, help = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--help' || args[i] === '-h') help = true;
    else throw new Error('Use --apply or --help; this setup supports only npm run dev on Vite port 5173');
  }
  return { apply, help };
}

export function servePlan(status, config) {
  if (status?.BackendState !== 'Running' || !status.Self || status.Self.Online === false) throw new Error('Tailscale is not connected. Connect/sign in using Tailscale first.');
  const dns = typeof status.Self.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  if (!dns || dns.length > 253 || !dns.endsWith('.ts.net') || !dns.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('No usable Tailscale HTTPS hostname. Enable MagicDNS and check tailscale status.');
  const origin = 'https://' + dns, target = 'http://127.0.0.1:5173';
  if (config !== null && !object(config)) throw new Error('Unrecognized Serve configuration; no changes made.');
  config ??= {};
  const keysKnown = Object.keys(config).every(key => configKeys.has(key));
  if (keysKnown && Object.values(config).every(empty)) return { origin, target, state: 'empty' };
  const address = dns + ':443';
  // Never merge/replace other proxies, foreground sessions, Services or Funnel.
  const tcp = config.TCP, web = config.Web, endpoint = web?.[address];
  const handler = endpoint?.Handlers?.['/'];
  const noFunnel = empty(config.AllowFunnel) || (object(config.AllowFunnel) && Object.keys(config.AllowFunnel).every(key => key === address && config.AllowFunnel[key] === false));
  const matching = keysKnown && empty(config.Foreground) && empty(config.Services) && noFunnel
    && object(tcp) && Object.keys(tcp).length === 1 && object(tcp['443']) && Object.keys(tcp['443']).length === 1 && tcp['443'].HTTPS === true
    && object(web) && Object.keys(web).length === 1 && object(endpoint) && Object.keys(endpoint).length === 1
    && object(endpoint.Handlers) && Object.keys(endpoint.Handlers).length === 1
    && object(handler) && Object.keys(handler).length === 1 && handler.Proxy === target;
  return { origin, target, state: matching ? 'matching' : 'conflict' };
}

function readCommand(bin, args, env) {
  const result = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tailscale ${args.join(' ')} failed: ${result.stderr?.trim() || 'exit ' + result.status}`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Tailscale returned invalid JSON; no configuration changes will be attempted.'); }
}

export function runSetup(args, { env = process.env, read = readCommand, apply, log = console.log } = {}) {
  const options = setupOptions(args);
  if (options.help) {
    log('Usage: npm run tailscale:setup -- [--apply]\nDev mode only: HTTPS Serve proxies Vite on 127.0.0.1:5173, which proxies /api to the backend.\nDefault: inspect and print a plan only. --apply enables tailnet-only HTTPS Serve.\nOptional TAILSCALE_BIN specifies a CLI path. No Canvas data, agents or ACLs are changed; Funnel is never enabled.');
    return;
  }
  const cliEnv = { ...env, TAILSCALE_BE_CLI: '1' };
  const candidates = env.TAILSCALE_BIN ? [env.TAILSCALE_BIN] : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  let bin, status;
  for (const candidate of candidates) {
    try { status = read(candidate, ['status', '--json'], cliEnv); bin = candidate; break; }
    catch (error) { if (error.code !== 'ENOENT' || env.TAILSCALE_BIN) throw error; }
  }
  if (!bin) throw new Error('Tailscale CLI not found. Install CLI integration or set TAILSCALE_BIN to its executable path.');
  const config = read(bin, ['serve', 'status', '--json'], cliEnv);
  const plan = servePlan(status, config);
  const command = ['serve', '--bg', '--https=443', plan.target];
  log('Canvas URL: ' + plan.origin);
  log('Local proxy target: ' + plan.target);
  log('No application authentication: permitted tailnet users can control terminals and access files as your OS user. Restrict access using Tailscale policies; never use Funnel.');
  log(`Start/restart dev yourself: AGENT_CANVAS_PUBLIC_ORIGIN=${quote(plan.origin)} npm run dev`);
  log('No build step required. Vite and the backend stay bound to loopback; Vite port 5173 is fixed.');
  log('Local Pi agents continue using loopback. This script does not restart Canvas or persist environment settings.');
  if (plan.state === 'conflict') throw new Error('Existing Serve/Funnel configuration conflicts with this plan. Nothing changed; inspect tailscale serve status manually. The script never resets or overwrites existing configuration.');
  if (plan.state === 'matching') {
    log('The matching tailnet-only Serve proxy is already configured; no changes made.');
    return plan;
  }
  log('Serve command: TAILSCALE_BE_CLI=1 ' + quote(bin) + ' ' + command.map(quote).join(' '));
  if (!options.apply) {
    log('Dry run only. To enable Serve: npm run tailscale:setup -- --apply');
    return plan;
  }
  const execute = apply || ((binary, params, environment) => {
    const result = spawnSync(binary, params, { env: environment, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Serve setup failed. Inspect tailscale serve status before retrying.');
  });
  // Recheck immediately before applying, including changes made while inspecting.
  if (servePlan(status, read(bin, ['serve', 'status', '--json'], cliEnv)).state !== 'empty') throw new Error('Serve configuration changed; stopped without overwriting it.');
  execute(bin, command, cliEnv);
  if (servePlan(status, read(bin, ['serve', 'status', '--json'], cliEnv)).state !== 'matching') throw new Error('Serve verification failed. Inspect tailscale serve status manually; do not assume tailnet-only access. No automatic reset will be performed.');
  log('Tailnet-only HTTPS Serve configured. Run npm run dev with the printed origin setting.');
  log('Disable this proxy manually: TAILSCALE_BE_CLI=1 ' + quote(bin) + ' serve --https=443 off');
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runSetup(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
