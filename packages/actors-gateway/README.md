# @relaycast/actors-gateway

A stateless Node 22 gateway in front of relaycast `Workspace` actors running on
[durable-actors](https://github.com/TerseAI/durable-actors) (one actor per
workspace, each with its own SQLite database; see `packages/actors-workspace`).
It replaces the Bun example that used to live in `examples/terse/gateway`.

```
client ──HTTP/WS──▶ gateway
                     ├─ POST /v1/workspaces ─────────▶ Workspace[<new snowflake>].create(request, tag)
                     ├─ Bearer ar_<kind>_<wsid>_<tag>_… ─▶ tag verified ──▶ Workspace[wsid].handle(request)
                     ├─ /v1/ws, /v1/node/ws ─────────▶ handle(upgrade probe) ──▶ grant ──▶ find-websocket ──▶ bridged socket
                     ├─ /internal/* ─────────────────▶ gateway (create) or Workspace[id].handle
                     └─ /_relayfiles?token=… ─────────▶ file store (local disk; gcs/s3 later)
```

The gateway holds no workspace state. An `ar_` credential names its workspace,
the keyring verifies its routing tag (so a credential for a workspace this
deployment never tagged is refused without an actor call), and that
workspace's actor authenticates it against its own tables.

## Control plane

The gateway speaks the durable-actors 0.14.6 control-plane HTTP API directly
(`src/actors.ts`): `POST …/actors/Workspace/{id}/invoke` with
`{requestId, method, args, homeRegion?}`, retrying a `not_executed` outcome
once, and `POST …/find-websocket` for socket grants. The `durable-actors`
package exposes its client runtime only under unexported paths and targets Bun,
so the gateway does not depend on it; replies are validated with zod.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `DURABLE_ACTORS_CONTROL_PLANE_URL` | required | Control plane origin (`http://127.0.0.1:7100` for `durable-actors dev`) |
| `DURABLE_ACTORS_PROJECT_ID` | required | Project id (`local` for the dev runtime) |
| `DURABLE_ACTORS_SECRET` (alias `DURABLE_ACTORS_API_KEY`, or `_FILE`) | unset | Application credential sent as `Authorization: Bearer`; a local runtime needs none |
| `DURABLE_ACTORS_HOME_REGION` | unset | Passed as `homeRegion` on every call |
| `RELAYCAST_FILE_SIGNING_SECRET` (or `_FILE`) | required | HMAC secret shared with the actors, which sign `/_relayfiles` URLs |
| `RELAYCAST_CREDENTIAL_KEYRING` (or `_FILE`) | required | `{"current":"a","keys":{"a":"<secret ≥16 chars>"}}`; signs new workspaces' tags, verifies every credential's tag. Rotate by adding a version and making it current; removing a version locks out its credentials |
| `RELAYCAST_INTERNAL_SECRET` (or `_FILE`) | unset | Enables `/internal/*`; at least 32 characters, and the actors must be configured with the same value |
| `RELAYCAST_PUBLIC_WORKSPACE_CREATE` | `true` | `false` hides `POST /v1/workspaces` behind a generic 404; any other value is refused |
| `RELAYCAST_FILE_STORE` | `local` | `local`, `gcs` or `s3` (`gcs`/`s3` are not implemented yet and refuse to start) |
| `RELAYCAST_FILE_DIR` | `/data/files` | Where the `local` store keeps bytes (`<key>` plus a `<key>.type` sidecar) |
| `RELAYCAST_MAX_UPLOAD_BYTES` | `67108864` | Largest request body the gateway reads (413 `payload_too_large` beyond it) |
| `RELAYCAST_SHUTDOWN_GRACE_MS` | `10000` | How long SIGTERM waits for in-flight requests |
| `RELAYCAST_LOG_FORMAT` | `json` | `json` (one object per line) or `text` |
| `RELAYCAST_ENV` | `production` | Environment label in the startup log |

A directly set variable wins over its `_FILE` variant. A missing or malformed
setting, an unreadable `_FILE`, a short internal secret or an invalid keyring
prints one line and exits with code 64. Secret values are never logged.

## Routes

- `GET /health`, `GET /healthz`: 200 while the process is up.
- `GET /readyz`: 200 only when the control plane answers `GET /healthz`
  (cached for 5 s), else 503 `not_ready`.
- `OPTIONS *`: 204 CORS preflight (any origin, bearer credentials).
- `POST /v1/workspaces`: mints a snowflake workspace id, signs its tag with the
  keyring and calls `create(request, tag)` on the new actor. 404 `not_found`
  when `RELAYCAST_PUBLIC_WORKSPACE_CREATE=false`.
- Everything else (`/v1/*`, `/.well-known/*`, `/a2a/*`, …): requires
  `Authorization: Bearer ar_…`; the tag is verified, then the request goes to
  `handle` of the credential's workspace actor. A missing, legacy, forged or
  mistyped credential answers 401 `unauthorized` without an actor call.
- `GET /v1/deliveries?wait=<ms>` (≤ 25000): an actor answers at once (a waiter
  inside an actor call would hold its mailbox), so the gateway long-polls:
  forwards without `wait`, and while the answer is an empty list and time
  remains, pauses min(remaining, 750 ms) and asks again. The last answer is
  returned when a delivery arrives, at the deadline, or when the client goes
  away (polling stops).
- `/internal/*`: 404 `not_found` unless `RELAYCAST_INTERNAL_SECRET` is set.
  Bearer compared in constant time (401 `unauthorized`).
  `GET /internal/capabilities` mirrors the engine's capability shape;
  `POST /internal/workspaces {name, metadata?}` mints the id and tag here and
  calls `create` with a synthesized `POST /v1/workspaces`, answering with the
  actor's 201 and body; `DELETE /internal/workspaces/:id` and
  `POST /internal/workspaces/:id/api-key` go to `handle` of actor `:id`
  (a 64-bit snowflake; others get 400) with the `Authorization` header intact,
  so the actor checks the same secret.
- `/_relayfiles?token=…`: signed file URLs (see below).
- Actor or control-plane failures answer 502 `workspace_unavailable`; the
  control plane's URL and credential never appear in a response.
- Every response carries `x-request-id` (the client's, when it is a safe token,
  else a fresh UUID); it is forwarded to the actor and sent to the control
  plane. One JSON log line per request: method, path, status, ms, request id,
  workspace id when known.

## WebSocket bridge

`/v1/ws` and `/v1/node/ws` (token via `?token=` or `Authorization: Bearer`):

1. The workspace comes from the credential; a bad tag refuses the upgrade with
   a raw `HTTP/1.1 401`.
2. The actor's `handle` receives the upgrade as a probe (`upgrade: websocket`,
   `connection: Upgrade`, the client's other headers, no `sec-websocket-*`).
   A normal response (401, 403, 426, …) refuses the upgrade with that status;
   `200` with `x-relaycast-socket-grant: 1` and
   `{ ok: true, data: { metadata: <principal> } }` is a grant. A 200 that is
   not a grant refuses with 502.
3. `find-websocket` is called with the principal as metadata; the returned
   socket URL is a credential (never logged) and is connected to at once.
4. On the upstream's open the client's handshake completes and text frames
   flow both ways. Client frames are capped at 1 MiB; a binary frame closes
   the client with 1003. Close codes and reasons propagate in both directions
   (codes the library cannot send, such as 1005/1006/1015, become 1011; 1012
   from a control-plane restart passes through). The gateway pings clients
   every 30 s and terminates ones that stop answering. If the upstream cannot
   be opened, the client is closed with 1011.
5. SIGTERM stops accepting, closes bridged clients with 1012 `gateway
   restarting`, waits up to `RELAYCAST_SHUTDOWN_GRACE_MS` for in-flight HTTP
   requests, drops the rest and exits 0.

## File store

Actors never see file bytes: they sign `/_relayfiles` URLs
(`SignedUrlFileStorage` in the engine) and the gateway moves bytes to and from
a `FileStore` (`src/files/store.ts`):

- `PUT` + `put` token: `content-type` must equal the signed type (400
  `content_type_mismatch`); `content-length` (if present) and the bytes read
  must equal the signed size (400 `size_mismatch`; reading stops past it).
  The content type is stored with the object.
- `GET` + `get`: streams with the stored `content-type`, `content-length`,
  `x-content-type-options: nosniff`, and `content-security-policy: sandbox`
  for active types (HTML, SVG, XML, scripts).
- `HEAD` + `stat`: 200 with `x-relaycast-object-size`, or 404.
- `DELETE` + `delete`: 204; already gone is success; any failure is 500
  `delete_failed` so the engine's cleanup queue retries.
- 403 `forbidden` for a bad or expired token, 405 `method_not_allowed` for a
  token/method mismatch; CORS `*` with `GET, PUT, OPTIONS`.

`src/files/index.ts` is the single switch point (`RELAYCAST_FILE_STORE`);
`local` keeps bytes under `RELAYCAST_FILE_DIR` with path containment, so run
one instance on persistent storage, or add `gcs.ts` / `s3.ts` behind the same
interface for several.

## Run locally

Build the engine once at the repository root (`npm ci && npx turbo build
--filter=@relaycast/engine`), then start the actors and the gateway:

```sh
# Actors: `durable-actors dev` on 127.0.0.1:7100, project id `local`
RELAYCAST_PUBLIC_URL=http://127.0.0.1:8787 RELAYCAST_FILE_SIGNING_SECRET=dev-secret \
  npm run dev -w @relaycast/actors-workspace

# Gateway, in a second terminal
npm run build -w @relaycast/actors-gateway
DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:7100 DURABLE_ACTORS_PROJECT_ID=local \
RELAYCAST_FILE_SIGNING_SECRET=dev-secret \
RELAYCAST_CREDENTIAL_KEYRING='{"current":"a","keys":{"a":"dev-credential-tag-secret"}}' \
RELAYCAST_FILE_DIR=./files RELAYCAST_LOG_FORMAT=text \
  node packages/actors-gateway/dist/bin.js
```

Point any relaycast client at `http://127.0.0.1:8787`:

```sh
curl -s -X POST http://127.0.0.1:8787/v1/workspaces -H 'content-type: application/json' -d '{"name":"demo"}'
```

The container image is `docker/actors-gateway.Dockerfile` (built from the
repository root); it listens on 8787, keeps `local` files under the `/data`
volume, runs as `node` and health-checks `/healthz`.

## Development

```sh
npm run typecheck -w @relaycast/actors-gateway
npm test -w @relaycast/actors-gateway      # vitest, against an in-process fake control plane
npm run lint -w @relaycast/actors-gateway
```

`createGateway(config, { logger?, actors?, fileStore? })` from `src/server.ts`
returns `{ server, listen(), close(), socketCount }` for embedding and tests;
`src/bin.ts` is the CLI.
