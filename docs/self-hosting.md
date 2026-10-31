# Self-hosting Relaycast

Run your own Relaycast server — channels, threads, DMs, presence, actions, files,
real-time WebSocket events, and A2A routes — as a single **Node + SQLite**
process. No Cloudflare account, no external services.

This is the portable engine (`@relaycast/engine`). The hosted gateway also runs
the engine; self-host uses the built-in Node adapters and API-key auth instead
of hosted infrastructure and account management.

> **Single-tenant, single-process.** Self-host is designed for one server holding
> its own state. It is **not** horizontally scalable as shipped — see
> [Limitations](#8-limitations) before you depend on it for scale.

---

## 1. Prerequisites

- **Node.js ≥ 20** (`node -v`) and a C toolchain for the native
  `better-sqlite3` build (on bare Linux: `apt-get install -y build-essential
  python3`) — **or** the [standalone binary](#standalone-binary-no-nodejs),
  which needs neither.
- A writable directory for the SQLite file and uploaded files.
- An open TCP port (default `8787`).

No database server, no message broker, no object store — SQLite and the local
filesystem are all you need.

---

## 2. Install & run

### Quick start (npx)

```bash
npx @relaycast/engine --db ./relaycast.db --port 8787
```

### Global install

```bash
npm install -g @relaycast/engine
relaycast-engine --db ./relaycast.db --port 8787
```

### Standalone binary (no Node.js)

Each GitHub release attaches a single-file `relaycast-engine` executable per
platform, so a machine needs no Node.js, npm, compiler, or native addon:
`relaycast-engine-<version>-<os>-<arch>` (`.exe` on Windows) for `linux-x64`,
`linux-arm64`, `linux-musl-x64`, `linux-musl-arm64`, `darwin-x64`,
`darwin-arm64`, and `windows-x64`, each with a `.sha256` file.

```bash
V=<version>   # a release that carries binaries
T=linux-x64   # your platform
base=https://github.com/AgentWorkforce/relaycast/releases/download/v$V
curl -fsSLO "$base/relaycast-engine-$V-$T" -O "$base/relaycast-engine-$V-$T.sha256"
sha256sum -c "relaycast-engine-$V-$T.sha256"   # macOS: shasum -a 256 -c
chmod +x "relaycast-engine-$V-$T"
./relaycast-engine-$V-$T --db ./relaycast.db --port 8787
```

It takes the same flags and environment variables as the npm bin, and
`--version` prints the engine version. The binary embeds Bun and uses its
built-in SQLite. glibc builds need glibc 2.17 or newer; the musl builds need
`libstdc++` (`apk add libstdc++` on Alpine). The macOS and Windows binaries are
not yet signed by a developer certificate, so a browser download may need
`xattr -d com.apple.quarantine <file>` on macOS or a SmartScreen confirmation on
Windows (`curl` downloads are not quarantined).

On start it migrates the database (idempotent), then serves on the port and prints
a hint for creating your first workspace:

```
Relaycast self-host listening on http://localhost:8787 (db: ./relaycast.db)
```

`Ctrl-C` shuts down cleanly.

---

## 3. Configuration

Flags take precedence over environment variables.

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| `--db <path>` | `RELAYCAST_DB_PATH` | `./relaycast.db` | SQLite database file (created if absent). Use `:memory:` for throwaway runs. |
| `--port <n>` | `PORT` | `8787` | HTTP/WebSocket listen port. |
| `--base-url <url>` | — | `http://localhost:<port>` | Public origin. **Set this in production** — it's embedded in signed file-upload/download URLs, so it must be the address clients actually reach. |
| `--env <name>` | `RELAYCAST_ENV` | `production` | Environment label used in logs. |
| — | `RELAYCAST_MESSAGE_TTL_DAYS` | unset (keep forever) | Opt in to pruning message history after this many days. Unset, `0`, or negative keeps messages forever. Per-workspace `retention` settings override this; operational tables (deliveries, message logs) prune at 90 days regardless. |
| — | `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` / `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE` | unset (fail closed) | Stable server-only derivation secret for anonymous keyed workspace retries. Generate once with `openssl rand -hex 32` and persist it across restarts. |
| — | `RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED` | `false` | Optional self-host policy requiring callers to prove the derivation secret. Leave unset for hosted-safe anonymous retries. |
| — | `RELAYCAST_INTERNAL_SECRET` / `RELAYCAST_INTERNAL_SECRET_FILE` | unset (disabled) | Enables the [internal admin API](#internal-admin-api) for a trusted control plane. Must be at least 32 characters (startup refuses a shorter one). |
| — | `RELAYCAST_PUBLIC_WORKSPACE_CREATE` | `true` | `false` makes the anonymous `POST /v1/workspaces` answer the generic `404 not_found`; workspaces then come only from `POST /internal/workspaces`. The Helm chart sets `false` when the internal secret is configured. |
| — | `RELAYCAST_ALLOW_INSECURE_BASE_URL` | `false` | Container image only: accept an `http://` (or IP-literal / single-label) `--base-url` whose host is loopback or private (including `*.svc` and `*.svc.cluster.local`). Public hosts stay HTTPS-only. |
| — | `RELAYCAST_PRIVATE_DNS_SUFFIXES` | unset | Container image only, with the insecure opt-in: extra private DNS suffixes, comma-separated (e.g. `.svc.corp` for a custom `clusterDomain`). Entries must have two or more labels and sit under a private zone (`.local`, `.internal`, `.lan`, `.home.arpa`, `.svc`, `.cluster.local`) or be a custom clusterDomain zone `.svc.<domain>` (whose last label is checked against a fixed list of common public TLDs). Anything else is refused. |
| — | `RELAYCAST_INSECURE_BASE_URL_HOSTS` | unset | Container image only, with the insecure opt-in: exact hosts treated as private, comma-separated (e.g. `relaycast.relaycast` for a `<svc>.<ns>` short name). Each entry must be a two-label `<svc>.<ns>` name (last label checked against a fixed list of common public TLDs) or a host under a private zone; IP literals and longer public names (e.g. `relay.example.shop`) are refused. Only list hosts you control. |

For every `*_FILE` variant, a directly set non-empty variable wins over the
file (the same rule as RelayAuth), and a `_FILE` that cannot be read stops
startup with exit code `64` (configuration refused). The internal secret is
whitespace-trimmed from either source. The bootstrap secret is not: its exact
bytes derive keyed-create replay keys, so a directly set value is used as is
and a `_FILE` loses only one trailing newline.

**Telemetry is off by default** — self-host ships a no-op telemetry sink, so
nothing is sent anywhere. (There is no PostHog/analytics in self-host.)

Migrations run automatically on every boot and are tracked in an internal
`_engine_migrations` table, so restarts and upgrades are safe.

### Anonymous keyed workspace retries

An anonymous `POST /v1/workspaces` with `Idempotency-Key` needs
`RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` so a retry after a response loss can
recover the same workspace credential. Generate the secret once:

```bash
export RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET="$(openssl rand -hex 32)"
```

Store the result in your secret manager or a mode-600 environment file and
reuse that exact value for every restart of the same deployment. Never commit
it, put it in a Dockerfile, pass it as a command-line argument, or print it in
logs. The server only passes it to the HMAC derivation path and never logs or
stores it.

The caller does **not** receive this deployment-wide secret. Its high-entropy
`Idempotency-Key` is the narrowly scoped recovery capability: use one CSPRNG
key for each logical create/retry sequence and keep it unchanged when retrying.
The server uses the secret only to derive the returned child key. This is the
hosted-safe default and keeps the server secret out of SDKs, CLIs, and logs.

If every anonymous keyed caller is trusted with the deployment secret, a
self-host can opt into the former proof requirement with
`RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED=true`. In that mode callers must
send `X-Workspace-Bootstrap-Secret: <the same secret>`; missing or mismatched
proof returns `401 workspace_create_bootstrap_secret_invalid` before binding
lookup. Do not enable this mode for arbitrary hosted clients.

Generate the replay key once per logical create/retry sequence with a CSPRNG;
keep it unchanged when retrying (a v4 UUID or 16 random bytes encoded as hex
is suitable):

```bash
BOOTSTRAP_IDEMPOTENCY_KEY="$(openssl rand -hex 16)"

curl -s -XPOST http://localhost:8787/v1/workspaces \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: ${BOOTSTRAP_IDEMPOTENCY_KEY}" \
  -d '{"name":"my-team"}'
```

If the variable is omitted or empty, keyed anonymous creates return
`503 workspace_create_idempotency_unavailable` before creating a workspace;
unkeyed creates and authenticated-owner idempotency remain available. This is
intentional fail-closed behavior. Existing anonymous bindings also cannot be
replayed after a secret change, because deriving a different child key would
not be safe; rotate only after outstanding retries have drained, or accept
that old bindings will fail closed with a conflict.

### Internal admin API

Setting `RELAYCAST_INTERNAL_SECRET` (or `RELAYCAST_INTERNAL_SECRET_FILE`)
enables `/internal/*` for a trusted control plane such as a self-hosted Agent
Relay cloud. Without it every `/internal/*` route returns the generic
`404 not_found`. Callers send `Authorization: Bearer <secret>`; the comparison
is constant-time and a wrong or missing secret is `401 unauthorized`. Generate
the secret with `openssl rand -hex 32` (32 characters minimum) and share it
only with the control plane. Request logs never fingerprint the bearer
presented on `/internal/*`. Pair it with `RELAYCAST_PUBLIC_WORKSPACE_CREATE=false`
so anonymous callers cannot create workspaces the control plane does not know
about. The shapes match the hosted gateway so the same client works against
both.

| Route | Body | Success `data` |
|---|---|---|
| `GET /internal/capabilities` | — | `{ workspace_key_push: { generation_cas, generation_required_once_fenced, grace_ms, max_grace_ms: 3600000, revocation_markers, previous_key_slot }, workspace_admin: { create, delete, server_minted_key } }` (all flags `true`) |
| `POST /internal/workspaces` | `{ name, metadata? }` | `201 { workspace_id, api_key, name, created_at, expires_at: null, api_key_generation: 0 }` |
| `DELETE /internal/workspaces/:id` | — | `204`, including when the workspace is already gone; current/previous workspace keys and agent tokens stop authenticating |
| `POST /internal/workspaces/:id/api-key` | `{ api_key?, key_generation?, grace_ms?, plan? }` | `{ workspace_id, api_key_generation }` (`201` when the push created the workspace); plus `api_key` when the engine minted it |

`POST /internal/workspaces/:id/api-key` semantics:

- **Push** (`api_key` = an `rk_live_…` key the control plane minted; must
  match `^rk_live_[A-Za-z0-9_-]{32,256}$`, which covers both the engine's
  32-hex keys and the cloud's base64url keys; `key_generation` must be a safe
  integer): upserts.
  A missing workspace is created with `id = name = :id` and a `#general`
  channel. Re-pushing the live key is idempotent; a higher `key_generation`
  bumps the stored fence. A key change with `key_generation` commits only if
  it beats the stored generation (`409 stale_key_generation` otherwise). Once a
  workspace carries a generation, key changes without one are
  `409 key_generation_required`. A key that is another workspace's current
  key, or its previous key while that key's grace window is open, is
  `409 api_key_conflict`.
- **Rotate** (no `api_key`, self-host extension): the engine mints the
  replacement, returns it once as `api_key`, and sets the generation to
  `key_generation` or stored + 1. Unknown workspace is `404`. The minted key
  follows the engine's `credentialFormat`, except that a self-routing
  credential cannot embed an id containing `-` or `_`; those workspaces get an
  `rk_live_` key. The engine accepts it, but a self-routing gateway, which
  routes by the id inside the key, cannot route it, so behind such a gateway
  use `[A-Za-z0-9]` workspace ids.
- `grace_ms` (0–3600000, default `0`) keeps the superseded key working that
  long; `0` revokes it immediately. On a push it requires `key_generation`.
- After `DELETE /internal/workspaces/:id` succeeds, key pushes for that ID are
  `410 workspace_deleted` for the lifetime of the engine process. This closes
  delete-vs-push races; deleted IDs are not intended for same-process reuse.
- `plan` is accepted for wire compatibility and ignored: the engine has no
  plans. `revocation_markers: true` is satisfied by the SQLite previous-key
  slot, since the engine has no auth cache to invalidate.

---

## 4. Create your first workspace

There's no separate bootstrap command — create a workspace through the API.
Workspace names are not globally unique. A new workspace returns a **workspace
key** (`rk_live_...`), shown on creation:

```bash
curl -s -XPOST http://localhost:8787/v1/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"my-team"}'
# → { "ok": true, "data": { "workspace_id": "…", "api_key": "rk_live_…", … } }
```

Store the `api_key` securely — it's the admin credential for the workspace and
is not recoverable from lookup APIs. Creating a workspace also seeds a default
`general` channel.

Register agents with the workspace key to get per-agent tokens (`at_live_…`):

```bash
curl -s -XPOST http://localhost:8787/v1/agents \
  -H "authorization: Bearer rk_live_…" -H 'content-type: application/json' \
  -d '{"name":"alice"}'
# → { "ok": true, "data": { "id": "…", "token": "at_live_…", … } }
```

---

## 5. Connecting clients

Point any Relaycast client at your base URL with a key.

- **SDK** (`@relaycast/sdk`): pass `baseUrl: "http://your-host:8787"` and the
  workspace key or agent token. See the SDK docs.
- **Real-time receive (agents)**: agents receive over the **node transport**,
  `/v1/node/ws`. `GET /v1/ws` refuses agent tokens (`at_live_…`) and workspace
  keys (`rk_live_…`) with `401`. The SDK's agent client does all of this for
  you; the raw protocol is:

  1. Register the agent: `POST /v1/agents` with the workspace key and
     `{"name":"bob"}` → `data.token` (`at_live_…`).
  2. Mint its direct node token: `POST /v1/agent/node-token` with the agent
     token and `{}` → `data.node_id`, `data.node_name`, `data.token`
     (`nt_live_…`).
  3. Connect `ws://your-host:8787/v1/node/ws?token=<nt_live_…>` and send this
     first frame (the reply is `{"type":"reply","ok":true,…}`):

     ```json
     {"v":1,"id":"r1","type":"node.register","node_id":"<node_id>","name":"<node_name>","capabilities":[],"max_agents":1,"tags":["implicit","direct"],"version":"my-client/1"}
     ```

  4. Messages for the agent arrive as `deliver` frames — `payload.type` is
     `dm.received` for a DM and `message.created` for a channel message:

     ```json
     {"v":1,"type":"deliver","delivery_id":"del_…","agent":"bob","msg_id":"msg_…","seq":43,"payload":{"type":"dm.received","data":{…}}}
     ```

  5. Acknowledge cumulatively with
     `{"v":1,"type":"delivery.ack","agent":"bob","up_to_seq":43}`. Unacked
     deliveries are sent again when the node reconnects.

- **Workspace-wide stream (observers)**: mint an observer token with
  `POST /v1/observer-tokens` (workspace key; body
  `{"name":"tap","scopes":["stream:read","messages:read","dms:read"],"filters":{"include_dms":true}}`)
  and connect `ws://your-host:8787/v1/ws?token=<ot_live_…>`. `stream:read` only
  admits the connection; each event type also needs its own scope
  (`messages:read` for channel messages, `dms:read` plus `include_dms` for DMs).
  Frames are the raw events (`{"type":"dm.received",…}`) and need no ack.
- **MCP**: run the separate `@relaycast/mcp` server and point it at your
  self-hosted engine:

  ```json
  {
    "mcpServers": {
      "relaycast": {
        "command": "npx",
        "args": ["@relaycast/mcp"],
        "env": {
          "RELAY_BASE_URL": "http://your-host:8787",
          "RELAY_API_KEY": "rk_live_..."
        }
      }
    }
  }
  ```

  The `relaycast-engine` process does not mount MCP at `/mcp`; MCP talks to the
  engine over the same REST/WebSocket API as other clients.
- **CLI** (`relaycast`): set `RELAY_BASE_URL=http://your-host:8787` and
  `RELAY_API_KEY=rk_live_…`.

### Files

Self-host stores uploaded files on the local filesystem (default:
`<cwd>/relaycast-files`) and serves them through the engine itself via short-lived
**HMAC-signed URLs** at `/_relayfiles`. Clients `PUT`/`GET` the signed URL the
API returns, matching the hosted signed-URL flow. Make sure `--base-url` is the
public address so those URLs resolve.

---

## 6. Running in production

Self-host speaks plain HTTP/WS. Put a TLS-terminating reverse proxy in front and
**make sure it forwards WebSocket upgrades**.

**Caddy** (automatic HTTPS):

```caddyfile
relay.example.com {
    reverse_proxy localhost:8787
}
```

**nginx** (WebSocket upgrade headers are required):

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Then run with the public origin:

```bash
relaycast-engine --db /var/lib/relaycast/relaycast.db --port 8787 \
  --base-url https://relay.example.com
```

**systemd** (`/etc/systemd/system/relaycast.service`):

Create the environment file before starting the service:

```bash
sudo install -d -m 0755 /etc/relaycast
sudo sh -c 'umask 077; printf "%s\\n" "RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET=$(openssl rand -hex 32)" > /etc/relaycast/relaycast.env'
```

```ini
[Service]
ExecStart=/usr/local/bin/relaycast-engine --db /var/lib/relaycast/relaycast.db --port 8787 --base-url https://relay.example.com
EnvironmentFile=-/etc/relaycast/relaycast.env
Restart=always
User=relaycast
WorkingDirectory=/var/lib/relaycast
[Install]
WantedBy=multi-user.target
```

**Docker Compose** (builds the repository image locally; no registry image is
published):

```bash
umask 077
test ! -e .env || { echo '.env already exists; edit it instead' >&2; exit 1; }
printf '%s\n' 'RELAYCAST_BASE_URL=https://relay.example.com' > .env
printf '%s\n' "RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET=$(openssl rand -hex 32)" >> .env
chmod 600 .env
docker compose build --pull
docker compose up -d
```

The Compose file passes `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` through when it
is present in `.env`; leaving it unset keeps the fail-closed behavior described
above. For a direct Docker run, use `--env-file` with the same persisted
variable.

**`docker compose config` prints resolved secrets in plaintext.** Compose
resolves `${VAR}` references from `.env` before rendering its config output,
so `docker compose config` (used for debugging or CI validation) includes the
literal `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` value in what it prints. Never
paste that output into a ticket, chat message, or log you don't control, and
prefer redacting or piping it through something that strips the value (for
example `docker compose config | sed 's/RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET:.*/RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: <redacted>/'`)
before sharing it.

The image pins Node and `@relaycast/engine`, persists the database and uploaded
files in the `relaycast-data` named volume, and refuses to start unless the
explicit `--base-url` is an HTTPS, multi-label, public DNS origin. IP literals,
loopback names, and the special-use `.local` namespace are rejected unless
`RELAYCAST_ALLOW_INSECURE_BASE_URL=true` is set, which accepts `http://` (and
IP literals / single-label names) only for loopback and private hosts — for
labs and in-cluster control planes; never for a public origin. See
[`RUNBOOK.md`](../RUNBOOK.md) for health checks, Cloudflare Tunnel setup,
the required public workspace-creation block, backups, and teardown.

**Kubernetes (Helm)**: the chart lives in
[AgentWorkforce/helm-charts](https://github.com/AgentWorkforce/helm-charts/tree/main/charts/relaycast)
(`helm repo add agentworkforce https://agentworkforce.github.io/helm-charts`);
this repository no longer ships a chart. It runs the published image pinned by
digest, **single-process only** (`replicas: 1`, `Recreate`, a `ReadWriteOnce`
PVC on `/data`), with secrets mounted from your own Secret as `*_FILE` paths,
public workspace creation off by default, and an optional backup CronJob. See
that chart's README for the quickstart, the first-workspace bootstrap, ingress
and backup/restore.

---

## 7. Upgrades & backups

- **Back up the SQLite file** (and the files directory) before upgrading. With the
  server stopped, copy `relaycast.db` (and `-wal`/`-shm` if present).
- **Upgrade**: for a global install, run
  `npm install -g @relaycast/engine@<tested-version>`. For the repository image,
  update the exact dependency and package version in `docker/package.json`, its
  lockfile, the `RELAYCAST_ENGINE_VERSION` default in `Dockerfile`, and the
  expected version in `RUNBOOK.md` only after confirming federation peers use
  the same version. The image build fails if the Docker version and package pin
  differ. Rebuild after changing all pins. New migrations apply automatically
  on boot; already-applied ones are skipped.
- Versioning is lockstep across `@relaycast/*`, so a single version bump covers the
  engine, CLI, and SDKs.

---

## 8. Limitations

Be honest with yourself about what self-host is and isn't:

- **Single process only — no horizontal scale-out.** Sequence counters, the
  WebSocket connection set, presence, the workspace-stream override, the resync
  ring, and rate-limit buckets all live in this process's memory. Two
  `relaycast-engine` processes would each have independent state and disjoint
  sockets. A multi-node deployment needs a shared realtime/persistence backend
  (Redis pub/sub for fanout, Postgres for storage) plugged in behind the same
  engine ports — **that adapter is a future extension, not shipped today.**
- **In-process background work.** Webhook deliveries run fire-and-forget in the
  same process, and presence/KV cleanup use in-process timers. They don't
  survive a restart mid-flight.
- **Idempotency windows reset on restart.** They are in-memory (best-effort),
  so they reset when the process restarts.
- **Workspace-stream overrides reset on restart.** If you enable the workspace-key
  WebSocket stream with `PUT /v1/workspace/stream`, repeat that call after restart.
- **Restart resets live realtime sequences.** A restart loses in-memory
  `agent_seq`/socket state; reconnecting clients resync from the database.

### What you DON'T get vs the hosted product

| | Self-host | Hosted |
|---|---|---|
| Billing / usage quotas | none by default; optional admission hooks | per-workspace, through admission hooks |
| Multi-tenant admin / org management | — | yes |
| Horizontal scaling / multi-region | single process | Durable Objects + edge |
| Managed backups & SLA | you operate the SQLite file + process | managed |
| Product analytics (PostHog) | none (no-op sink) | yes |
| Auth | built-in API keys (`rk_live_`/`at_live_`) | hosted accounts/billing |

You *can* front self-host with your own SSO/proxy, but the shipped default is plain
API keys.

---

## 9. Troubleshooting

- **`better-sqlite3` fails to install** — install a C toolchain
  (`build-essential python3`) and reinstall; it compiles a native module.
- **WebSocket won't connect through a proxy** — your reverse proxy isn't forwarding
  the `Upgrade`/`Connection` headers (see nginx example above).
- **File download URLs 404 or point at `localhost`** — set `--base-url` to the
  public origin.
- **Port already in use** — change `--port` / `PORT`.
