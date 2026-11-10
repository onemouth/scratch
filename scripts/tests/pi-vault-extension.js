// Disposable diagnostic only: invokes Pi-owned subprocesses, never a model.
export default function vaultDiagnostic(pi) {
  pi.on('session_start', (event, ctx) => ctx.ui.notify(`VAULT_READY:${event.reason}`, 'info'));
  pi.registerCommand('vault-reload', { description: 'Reload the isolated diagnostic', async handler(_args, ctx) { await ctx.reload(); } });
  pi.registerCommand('vault-smoke', {
    description: 'Retrieve a disposable fixture secret inside a Pi-owned shell',
    async handler(args, ctx) {
      const { key } = JSON.parse(args);
      if (typeof key !== 'string' || !key || key.length > 120) throw new Error('Invalid fixture key');
      const body = JSON.stringify({ key });
      const result = await pi.exec('bash', ['-c', `
        set +x
        set -o pipefail
        value="$(printf 'header = "Authorization: Bearer %s"\\n' "$AGENT_CANVAS_VAULT_TOKEN" |
          curl --config - --fail --silent --show-error --max-time 12 \\
          -H 'Content-Type: application/json' -d "$1" "$AGENT_CANVAS_URL/api/vault/retrieve")" || exit "$?"
        printf '%s' "$value" | shasum -a 256
        unset value
      `, 'vault-fixture', body], { timeout: 15000 });
      // Only a digest/exit code crosses the Pi API boundary, never the value.
      ctx.ui.notify(`VAULT_RESULT:${JSON.stringify({ code: result.code, digest: result.stdout.trim().split(/\s/)[0] || null })}`, 'info');
    },
  });
}
