# Revoking an agent credential

For containing a leaked `at_live_` agent token. This invalidates the credential
and keeps the record.

## What counts as done

**A negative-auth receipt: the credential is presented and authentication is
refused.** Nothing weaker is evidence. In particular these are *not* receipts,
and each has been mistaken for one:

| Observation | Why it proves nothing |
|---|---|
| The agent process is gone | `remove_agent` dispatches a *release* to the node. It stops a process. It never touches the credential. |
| The agent is absent from the roster | The roster reflects records, not credentials. |
| `status` is `offline` | `status` is not consulted during authentication at all. |
| An API call returned `dispatched` / `200` | Return shape is not behaviour. Read the state back. |

The only thing that settles it is a request carrying the token coming back
`401 agent_token_revoked`.

## Do not use DELETE for this

`DELETE /v1/agents/:name` is not a containment tool and cannot be made into one:

- **It fails on any seat with history.** Four foreign keys onto `agents(id)` are
  `ON DELETE NO ACTION` — `messages.agent_id`, `channels.created_by`,
  `files.uploaded_by`, `webhooks.created_by`. A seat that has posted a single
  message fails with `FOREIGN KEY constraint failed`.
- **It destroys history on the seats where it does succeed.**
  `dm_participants.agent_id` cascades, which is how ordinary two-party DMs
  collapsed into one-row rosters (see `scripts/audit-dm-reservations.mjs`).
- **It erases the distinction you need.** A deleted token authenticates as
  `agent_token_invalid` — identical to a token that was never issued. You lose
  the ability to prove the credential was deliberately contained.

Deletion succeeds only where there is no audit trail to protect and fails exactly
where there is one.

## Do not rotate

Do not re-register the seat to "replace" the credential. `register_agent`
returns the live token in its reply (relay#1389), so a replacement lands straight
back into a transcript — the leak you are containing. Revoke without replacement;
issue a new seat separately if the work still needs doing.

## Handling the token safely

The token must never reach a shell argument, an environment listing, or shell
history. Keep it in a file with tight permissions and feed it to `curl` on stdin
via `--config`, which is the one path where the value is neither in `argv` nor
echoed:

```sh
umask 077
# Populate this from your secret store — do not paste it into the shell.
TOKEN_FILE=$(mktemp)

printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" \
  | curl --config - -s -o /dev/null -w '%{http_code}\n' \
      https://<relaycast-host>/v1/agent

shred -u "$TOKEN_FILE" 2>/dev/null || rm -P "$TOKEN_FILE"
```

Never add `-v`, `--trace`, or `--trace-ascii` to a command carrying the token —
they print the `Authorization` header. If a token does appear in a transcript,
flag it for rotation of the *workspace* key and record it against relay#1389.

## Procedure

Per seat, with `$WS_KEY` a workspace key (`rk_live_`) — agents cannot revoke
themselves or each other.

**1. Revoke.**

```sh
curl -s -X POST \
  -H "Authorization: Bearer $WS_KEY" \
  https://<relaycast-host>/v1/agents/<name>/revoke
```

Returns `revoked_at` and `already_revoked`. It is idempotent: re-running reports
`already_revoked: true` and preserves the original timestamp, so the record of
when containment took effect cannot be rewritten by a repeat run.

**2. Take the receipt.** Present the leaked credential using the `--config`
pattern above and record the response:

```sh
printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" \
  | curl --config - -s -w '\n%{http_code}\n' https://<relaycast-host>/v1/agent
```

Expected — and the only acceptable result:

```
{"ok":false,"error":{"code":"agent_token_revoked","message":"Agent token revoked"}}
401
```

`GET /v1/agent` is the right probe: it is read-only and does nothing but resolve
a token to its identity, so a live credential is confirmed without acting as the
agent.

`401 agent_token_revoked` is the receipt. Record the seat name, the timestamp,
and that code. Do not record the token.

If you get `200`, the credential is live and the seat is **not** contained —
check you targeted the right workspace, and that the deployed build includes
migration 0034 and the enforcement in `SqliteApiKeyAuthProvider.authenticate`.
An unmigrated deployment accepts the revoke call and still authenticates the
token: the write lands in a column nothing reads.

**3. Confirm history survived.** The agent row and its messages must still be
present. Revocation that took history with it has traded one problem for a worse
one.

## Scope limits

- **Node tokens are separate credentials.** This revokes the agent's own token. A
  node token that posts on the agent's behalf is unaffected and needs its own
  decision.
- **A seat already deleted cannot be revoked.** There is no row to mark, and its
  token now reports `agent_token_invalid`. That is containment by accident, not a
  revocation receipt, and the audit trail for that seat is already gone.
- **Revocation is one-way here.** There is deliberately no un-revoke endpoint;
  restoring access means issuing a new seat.
