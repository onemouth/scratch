# Vault

There is **one and only one global Vault**, managed from the top-right **Vault** panel. It contains up to 256 uniquely named key/value entries and is not a card or Canvas node. Key names are public metadata; values are encrypted. Names are trimmed, case-sensitive and exact: `GH_TOKEN` and `gh_token` are different keys. Ordinary card/search/state APIs and SHM never expose values or encrypted payloads.

## Human workflow

1. Start Scratch normally. The backend console prints an ephemeral **Vault control code**. Enter it in the Vault panel to connect human controls. This is separate from the master password; never paste it into an Agent conversation. Server restart generates a different code. No API returns it and Pi never receives it.
2. Set up one master password (at least eight characters; use a long, unique password). This initializes and unlocks the Vault without creating any library card, view membership or placement. No second Vault can be created. Later restarts require UI unlock, never a password in an environment variable or shell command.
3. Add multiple keys in the Vault. Humans explicitly reveal/edit values while unlocked; secret changes require Save and are not stored as automatic browser drafts. Deleting one key requires confirmation; it does not reset the other keys.
4. Agent requests identify a **key name**. Approve once, approve that key until this Agent process ends, or deny. Approving `GH_TOKEN` does **not** approve any other key. The Vault button shows a pending-request count while human controls are connected, without interrupting terminal text.
5. Revoke grants individually or lock manually. Locking blocks retrieval and cancels pending requests, but preserves live process grants. Unlocking restores those grants. MVP has no idle/sleep locking. Backend restart always locks and loses grants/requests.

Reload/new/resume/fork inside the same Pi process retain per-key authorization. Closing/relaunching Pi creates a new credential/generation and needs approval again. Ended processes never transfer grants to replacements. Existing Pi processes launched without Vault support require a human-managed relaunch; Scratch never restarts them automatically.

Renaming a key cancels its pending requests and revokes its grants. Deleting it does the same. Recreating the same name creates a fresh internal entry identity and cannot inherit old grants. Updating a value without renaming its key retains the existing key grants. A request is pinned to the resolved entry, not a later replacement with the same name.

Vault setup, key edits and reset do not affect library cards, card IDs/sequences, tags/links, placements or view membership. Management is available in the top-right panel in either workspace. Maximized cards and Agents show no Vault button or floating shortcut; return to the normal workspace to open Vault.

The frontend holds its control code, revealed values and editing state only in page memory, not local/session storage or ordinary card drafts. Hiding a reveal, closing its editor/panel, disconnecting controls, locking, or observing a new Vault epoch clears sensitive state. Disconnect removes this page's control access; it does not lock the backend. JavaScript garbage collection cannot guarantee secure memory erasure.

## Reset, not recovery

**Reset Vault** requires typing `RESET VAULT`, not the old password. It deletes all entries, ciphertext and wrapping metadata, clears grants/pending requests and returns to initial password setup. All cards, Agents, views and placements remain intact. Fresh setup initializes the single Vault again. Reset does not change the ephemeral human control code.

Forgotten passwords cannot recover old secrets. Reset is not password recovery/change, cannot retract values already retrieved, and does not securely erase historical SQLite backups, WAL/free pages, filesystem snapshots or external copies. Keep backups protected; an old backup may remain decryptable with the old password.

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

## Human control API

Private routes require `X-Vault-Control: <CONTROL_CODE>`. Writes require `application/json`; all responses are no-store. No secret/credential query parameters; no automatic mutation retries.

| Route | Body / result |
| --- | --- |
| `GET /api/vault/status` | Public `{configured,locked,instance,epoch,revision}` |
| `GET /api/vault/entries` | Public entry metadata only |
| `GET /api/vault/control` | Status, entry metadata, pending requests and active grants |
| `POST /api/vault/setup` | `{password}`; initializes the single Vault, returns status |
| `POST /api/vault/unlock` | `{password}` |
| `POST /api/vault/lock` | `{}` |
| `POST /api/vault/reset` | `{confirmation:"RESET VAULT"}` |
| `POST /api/vault/entries` | `{key,value}`; returns sanitized entry |
| `PATCH /api/vault/entries/:id` | `{key?,value?}`; unlocked only |
| `GET /api/vault/entries/:id/value` | Unlocked `{id,key,value,epoch}` |
| `DELETE /api/vault/entries/:id` | `{confirm:true}`; works while locked |
| `POST /api/vault/requests/:id/decision` | `{decision:"once"|"process"|"deny"}` |
| `DELETE /api/vault/grants/:id` | `{}` |

Requests/grants identify `entryId`, `key`, Agent ID/name and process generation. They never grant the entire Vault. Entry IDs identify secret records, never library cards. Key names contain 1–120 trimmed characters without controls. Values contain 1–65536 UTF-8 bytes without NUL. Duplicate names fail without overwriting data. Card APIs cannot create or modify the Vault. Key names are available only through the Vault metadata API/control panel, not card search or SHM card summaries.

Status has a stable backend `instance` and monotonic `revision` within it. Lock/unlock/reset change the epoch; explicit reveal responses carry it. Frontend responses are fenced against stale binding, epoch and operation identity. Human controls poll bounded metadata, never secret values automatically.

## Storage and security

SQLite schema 8 stores one Vault configuration and separate encrypted entries, independent of card records. A random 256-bit Vault key uses AES-256-GCM with fresh 96-bit nonces and authenticated entry ID/key context. scrypt (`N=131072,r=8,p=1`, random 128-bit salt) derives the master-password wrapping key. Disk stores only authenticated ciphertext and wrapped-key/KDF metadata. Entry rename/value changes and unique-name checks are transactional.

Supported older libraries migrate transactionally. Supported older Vault records retain configuration, entry identities and ciphertext while obsolete card records/references are removed; duplicate keys, missing encrypted values, invalid metadata or missing configuration fail closed rather than silently discarding or overwriting secrets. Preserve backups and use isolated data with older code; schema-incompatible versions cannot reopen the upgraded database.

The backend retains the unlocked Vault key in memory and zeroes its owned Buffer on lock/reset/close; transient buffers are cleared where possible. It cannot guarantee removal of every copy from runtime/OS memory or swap. Vault plaintext/passwords are not persisted, broadcast, exported, logged or included in normal API errors.

This avoids **directly pasting secrets into model context**. It is **not** isolation from authorized shell code or hostile processes under the same OS user: commands can print, transform, transmit or retain values, and local processes may inspect memory/files/browser state. Lock/revoke/reset cannot retract retrieved values. Vault's independent random capabilities do not authenticate the other Canvas endpoints or sandbox the host.
