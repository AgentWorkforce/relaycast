# Ratify Protocol Relaycast runbook

This runbook is for the team operating `https://relay.ratifyprotocol.com` on
infrastructure controlled by Ratify Protocol. AgentWorkforce does not need host
access and does not operate this deployment.

## Operating boundary

The image contains `@relaycast/engine` **7.0.0** on Node 22.23.2 and stores all
state locally in SQLite plus a files directory. It requires an explicit HTTPS
public origin and exits before starting the engine if `--base-url` is missing,
plaintext, single-label, or loopback.

Self-hosted Relaycast is **single-tenant and single-process**. It is **not
horizontally scalable as shipped**. Do not run multiple engine replicas against
this volume: WebSocket connections, presence, sequencing, and rate limits have
in-process state. This package is an interoperability deployment, not a scale
claim.

## Prerequisites

- A Linux host with `linux/amd64` or `linux/arm64`.
- Docker Engine with Docker Compose v2 (`docker compose version`).
- Outbound access to Docker Hub and npm while building the image.
- The `relay.ratifyprotocol.com` zone managed in Cloudflare and permission to
  create a named Cloudflare Tunnel and its DNS route.
- `cloudflared` installed on the host. Follow Cloudflare's
  [locally-managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/).
- Enough durable disk for `/data/relaycast.db`, SQLite WAL files, uploaded
  files, and off-host backups.

No database server, object store, message broker, or inbound firewall opening
is required. Compose binds the engine only to `127.0.0.1:8787`; the tunnel makes
the public connection.

## Build and run

From a clean checkout of this repository:

```bash
printf '%s\n' 'RELAYCAST_BASE_URL=https://relay.ratifyprotocol.com' > .env
printf '%s\n' 'RELAYCAST_PORT=8787' >> .env
docker compose build --pull
docker compose up -d
```

The Compose variable and the image entrypoint both enforce the public origin.
The duplicate check is intentional: the engine's upstream fallback is
`http://localhost:8787`, which is not a valid federation authority.

Confirm the installed engine, container state, and local health endpoint:

```bash
docker compose exec relaycast node -p \
  "require('/opt/relaycast/node_modules/@relaycast/engine/package.json').version"
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:8787/health
```

The version command must print `7.0.0`, and Compose should eventually report
`healthy`. The health response must contain `"ok":true`; its `version` field is
the gateway/application version, not reliable evidence of the installed engine
package version.

Bootstrap the one Ratify workspace while the engine is reachable only over the
host loopback interface:

```bash
umask 077
curl --fail --silent --show-error \
  --request POST http://127.0.0.1:8787/v1/workspaces \
  --header 'content-type: application/json' \
  --data '{"name":"ratify-protocol"}' \
  --output ratify-workspace-bootstrap.json
```

The response contains the only copy of the `rk_live_...` workspace admin key.
Move it into Ratify's secret manager, then securely remove the bootstrap file.
Do not repeat this command: workspace names are not unique, so a repeat creates
another workspace and key.

In engine 7.0.0, `POST /v1/workspaces` is intentionally unauthenticated for
initial bootstrap. The tunnel rule below blocks that exact path before the
service becomes public; omitting the rule would allow arbitrary public workspace
creation and unbounded local state growth.

Useful service commands:

```bash
docker compose logs --follow --tail=200 relaycast
docker compose restart relaycast
docker compose up -d --build
```

## Put it behind a Cloudflare named tunnel

Authenticate once, create the named tunnel, and add the DNS route:

```bash
cloudflared tunnel login
cloudflared tunnel create ratify-relaycast
cloudflared tunnel route dns ratify-relaycast relay.ratifyprotocol.com
```

The create command prints a tunnel UUID and writes a `<UUID>.json` credential.
Create `~/.cloudflared/config.yml`, substituting the actual UUID and operator
home directory:

```yaml
tunnel: <UUID>
credentials-file: /home/<operator>/.cloudflared/<UUID>.json
ingress:
  # Bootstrap is complete. Never expose unauthenticated workspace creation.
  - hostname: relay.ratifyprotocol.com
    path: ^/v1/workspaces/?$
    service: http_status:403
  - hostname: relay.ratifyprotocol.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Validate the rules, then run the tunnel in the foreground for the first check:

```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://relay.ratifyprotocol.com/v1/workspaces
cloudflared tunnel ingress rule https://relay.ratifyprotocol.com/health
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run ratify-relaycast
```

From another terminal or machine:

```bash
curl --fail --silent --show-error https://relay.ratifyprotocol.com/health
workspace_create_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST https://relay.ratifyprotocol.com/v1/workspaces \
  --header 'content-type: application/json' \
  --data '{"name":"must-not-be-created"}')"
test "$workspace_create_status" = 403
```

Cloudflare terminates TLS and forwards HTTP/WebSocket traffic to the loopback
port. Keep the engine's `--base-url` set to the external HTTPS origin, not the
local tunnel target.

For unattended Linux operation, install `cloudflared` as a systemd service.
Pass the config path explicitly because `sudo` otherwise looks under `/root`:

```bash
sudo cloudflared --config "$HOME/.cloudflared/config.yml" service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

See Cloudflare's [Linux service guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/linux/)
for distribution-specific details.

## State and backups

The named Docker volume is `relaycast-data` and is mounted at `/data`:

- `/data/relaycast.db` is the SQLite database.
- `/data/relaycast.db-wal` and `/data/relaycast.db-shm` may exist while running.
- `/data/relaycast-files/` contains uploaded file bodies and content-type
  sidecars.

Take a consistent backup by stopping the single engine process, copying the
entire volume, and starting it again:

```bash
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
docker compose stop relaycast
container_id="$(docker compose ps --all --quiet relaycast)"
docker cp "${container_id}:/data/." "$backup_dir"
docker compose start relaycast
test -f "$backup_dir/relaycast.db"
```

If the copy fails, run `docker compose start relaycast` before troubleshooting.
Encrypt and move the backup directory off-host according to Ratify's retention
policy. A database-only copy is incomplete when users have uploaded files.

Before any image upgrade, repeat the backup and confirm that the hosted
`cast.agentrelay.com` deployment and this deployment will run the same engine
version. Version skew is a federation release blocker. Do not infer the hosted
engine dependency from its `/health` application-version field.

## Tear down

Stop and remove the service containers while preserving all state:

```bash
docker compose down
sudo systemctl disable --now cloudflared
```

The named volume remains and a later `docker compose up -d` reuses it. Removing
the volume is destructive and is not part of normal teardown. Only after an
off-host backup is verified and permanent deletion is intended:

```bash
docker compose down --volumes
```

Delete the Cloudflare DNS route and named tunnel separately in Cloudflare when
the public deployment is permanently retired.
