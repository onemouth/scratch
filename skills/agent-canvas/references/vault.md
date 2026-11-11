# Vault retrieval

Only retrieve a key when the user asks. Vault is one global management-only secret store, not a card or Canvas node; setup/key edits/reset never alter ordinary cards, IDs, placements or views. Key names are trimmed, exact and case-sensitive. Metadata is available through the Vault API, never card search/SHM.

## Agent retrieval by key

Canvas launches Pi with a private `AGENT_CANVAS_VAULT_TOKEN`, scoped to its current process rather than a session. Never print it or copy it into task text. Agent IDs, Origin and layout headers are not credentials; a process token cannot operate human controls.

Public `GET /api/vault/entries` lists `{entries:[{id,key,createdAt,updatedAt}]}`. Use `POST /api/vault/retrieve` with JSON `{ "key": "GH_TOKEN" }` and a Bearer credential. It waits up to 120 seconds for human approval when that process has no grant for that exact key. Success is raw UTF-8 text with `Cache-Control: no-store`; denied/locked/expired/missing/obsolete calls return non-2xx JSON errors. There is no automatic retry/replay. After timeout, disconnect or an uncertain outcome, ask before repeating. At most eight requests per process and 64 globally may be pending.

```sh
set +x
if vault_value="$(
  printf 'header = "Authorization: Bearer %s"\n' "$AGENT_CANVAS_VAULT_TOKEN" |
    curl --config - --fail --silent --show-error --max-time 125 \
      -H 'Content-Type: application/json' \
      -d '{"key":"GH_TOKEN"}' \
      "$AGENT_CANVAS_URL/api/vault/retrieve"
)"; then
  GH_TOKEN="$vault_value" gh pr list --repo owner/repo
  unset vault_value
fi
```

The credential is passed to curl on stdin rather than argv. Capture the secret inside the shell, not as model-visible tool output. Disable tracing; do not echo values, write secret files, pass values with `xargs`, or put them in URLs. Shell substitution strips trailing newlines; use a byte-preserving consumer when required. Commands can log/transmit environment variables. `unset` is cleanup, not guaranteed memory erasure.

## Authorization and lifecycle

- One approval covers one immutable key entry and the current Pi process, never the entire Vault. Rename/delete cancel pending requests and revoke that key's grants; recreating a name cannot inherit them. Value-only edits retain grants.
- Reload/new/resume/fork preserve per-key grants in the same process. Relaunch needs fresh authorization. Processes without credentials require a human-managed relaunch, never an automatic restart.
- Manual lock blocks retrieval and cancels pending requests but preserves live grants for unlocking. Backend restart locks and clears grants/requests. Revocation/reset cannot retract values already retrieved.
- Never obtain the human control code or master password, or approve/unlock/reset through human-control routes. Agent IDs, Origin and layout headers are not credentials.
- Approved subprocesses may still log/transmit secrets. This keeps values out of model context, not out of hostile authorized commands or same-user processes.
