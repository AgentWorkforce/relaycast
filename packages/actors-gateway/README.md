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
                     └─ /_relayfiles?token=… ─────────▶ file store (local disk, GCS or S3)
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
| `RELAYCAST_FILE_SIGNING_SECRET` (or `_FILE`) | required | HMAC secret shared with the actors, which sign `/_relayfiles` URLs; at least 32 characters |
| `RELAYCAST_CREDENTIAL_KEYRING` (or `_FILE`) | required | `{"current":"a","keys":{"a":"<secret ≥16 chars>"}}`; signs new workspaces' tags, verifies every credential's tag. Rotate by adding a version and making it current; removing a version locks out its credentials |
| `RELAYCAST_INTERNAL_SECRET` (or `_FILE`) | unset | Enables `/internal/*`; at least 32 characters, and the actors must be configured with the same value |
| `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` (or `_FILE`) | unset | Lets `POST /v1/workspaces` (and `POST /internal/workspaces`) with an `Idempotency-Key` be retried: the workspace id is derived from this secret, the key and the creating owner (anonymous, or the `ar_ws_` bearer's workspace), so a retry reaches the same actor. A direct value is used verbatim (not trimmed); a `_FILE` value loses one trailing newline. The actors must hold the same value; changing it changes the derived ids, so a retry after a change is a new create. Unset: such a create answers 503 `workspace_create_idempotency_unavailable`, as the engine does |
| `RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED` | `false` | The engine's self-host policy (`docs/self-hosting.md`): `true` makes an anonymous keyed `POST /v1/workspaces` prove the bootstrap secret with `X-Workspace-Bootstrap-Secret`. The gateway checks it at the edge (constant time, after the 503 above, before an id is derived or an actor called): missing or mismatched answers 401 `workspace_create_bootstrap_secret_invalid`; a matching one travels on to the actor's engine, which checks it again. The actors must be configured with the same value. Blank is unset (`false`); any other non-blank value (`TRUE`, `yes`, `true ` with a space) is refused, as the actors refuse it. With `true`, a secret an HTTP header cannot carry (leading or trailing space or tab, or any control character) is refused at startup rather than trimmed |
| `RELAYCAST_PUBLIC_WORKSPACE_CREATE` | `true` | `false` hides `POST /v1/workspaces` behind a generic 404; any other value is refused |
| `RELAYCAST_FILE_STORE` | `local` | `local`, `gcs` or `s3`; the object stores read `RELAYCAST_GCS_*` / `RELAYCAST_S3_*` (see [File store](#file-store)) |
| `RELAYCAST_FILE_DIR` | `/data/files` | Where the `local` store keeps bytes (`<key>` plus a `<key>.type` sidecar) |
| `RELAYCAST_MAX_UPLOAD_BYTES` | `67108864` | Largest request body the gateway reads, including a signed `/_relayfiles` upload (413 `payload_too_large` beyond it, with `connection: close`) |
| `RELAYCAST_ACTOR_INVOKE_TIMEOUT_MS` | `60000` | Budget for one actor `handle` call through the control plane (502 `workspace_unavailable` beyond it) |
| `RELAYCAST_ACTOR_CREATE_TIMEOUT_MS` | `180000` | Budget for one actor `create` call; it includes a new actor's first activation, which on a production control plane is a host claim plus the schema commit |
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
  when `RELAYCAST_PUBLIC_WORKSPACE_CREATE=false`. With an `Idempotency-Key`
  the id is derived from `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` (503
  `workspace_create_idempotency_unavailable` without it) and, when
  `RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED=true`, one without an `ar_ws_`
  bearer (no Authorization, or any other bearer, which the engine would refuse
  anyway) must carry `X-Workspace-Bootstrap-Secret` (401
  `workspace_create_bootstrap_secret_invalid` without it, no actor called);
  an owner-keyed create (`ar_ws_` bearer) is authenticated through the owner's
  actor instead, and with proof required the gateway supplies the proof to the
  child actor itself. These edge checks come before the engine's own: a key
  shorter than the engine's 32-character floor answers 401 at the gateway when
  its proof is bad or missing, and 503 when no secret is configured, where the
  engine alone would answer 400 `workspace_create_idempotency_key_too_weak`;
  only a create the gateway admits reaches that answer in the actor.
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
  actor's 201 and body (a keyed one is authenticated by the internal secret
  alone, as the engine's own internal create is: with proof required, the
  gateway adds the proof itself); `DELETE /internal/workspaces/:id` and
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
   (1005 "no status" is sent as 1000 and 1006 "abnormal closure" as 1001;
   other codes the library cannot send, such as 1004 and 1015, become 1011;
   1012 from a control-plane restart passes through). The gateway pings clients
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
  for active types (HTML, SVG, XML, scripts, PDF).
- `HEAD` + `stat`: 200 with `x-relaycast-object-size`, or 404.
- `DELETE` + `delete`: 204; already gone is success; any failure is 500
  `delete_failed` so the engine's cleanup queue retries.
- 403 `forbidden` for a bad or expired token, 405 `method_not_allowed` for a
  token/method mismatch; CORS `*` with `GET, PUT, OPTIONS`.

`src/files/index.ts` is the single switch point (`RELAYCAST_FILE_STORE`).
Every store keeps one object per key (`<workspace>/<file>/<name>`, which the
token already constrains; the store refuses `..`, empty segments and
backslashes again) with the signed content type stored alongside it.

### `local` (default): one replica

Bytes live under `RELAYCAST_FILE_DIR` as `<key>` plus a `<key>.type` sidecar,
with path containment. The directory is the only copy, so this is a
**single-replica** deployment on persistent storage: in Kubernetes, one pod
with a `ReadWriteOnce` PVC (and a `Recreate` strategy, since two pods cannot
mount it at once). Run more than one gateway only with an object store.

### `gcs`: Google Cloud Storage (`@google-cloud/storage`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAYCAST_GCS_BUCKET` | required | Bucket name |
| `RELAYCAST_GCS_PREFIX` | unset | Object name prefix (`<prefix>/<key>`); surrounding slashes are trimmed |

Credentials are Application Default Credentials: Workload Identity on GKE,
`GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account key, or the
metadata server on GCE/Cloud Run. The identity needs
`roles/storage.objectAdmin` on the bucket, or a custom role granting
`storage.objects.create`, `storage.objects.get` and `storage.objects.delete`
(the predefined creator/viewer roles lack delete). Uploads are
simple (non-resumable): bodies are capped by `RELAYCAST_MAX_UPLOAD_BYTES` and
already in memory when they reach the store, so a resumable session would only
add a round trip. Reads stream from the object; `HEAD` reads its metadata;
delete ignores an object that is already gone.

### `s3`: S3 and compatibles (`@aws-sdk/client-s3`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAYCAST_S3_BUCKET` | required | Bucket name |
| `RELAYCAST_S3_REGION` | required without an endpoint; `us-east-1` with one | AWS region (`auto` for R2) |
| `RELAYCAST_S3_ENDPOINT` | unset | `http(s)` origin of a non-AWS endpoint (MinIO, Cloudflare R2, Ceph RGW) |
| `RELAYCAST_S3_PREFIX` | unset | Object key prefix (`<prefix>/<key>`); surrounding slashes are trimmed |
| `RELAYCAST_S3_FORCE_PATH_STYLE` | `true` with an endpoint, else `false` | `https://host/bucket/…` (`true`) instead of `https://bucket.host/…` |

Credentials come from the SDK's default chain (`AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, shared config, IRSA/pod identity, instance role).
The identity needs `s3:PutObject`, `s3:GetObject` and `s3:DeleteObject` on
`arn:aws:s3:::<bucket>/<prefix>/*` (`s3:GetObject` also authorizes `HEAD`),
and `s3:ListBucket` on `arn:aws:s3:::<bucket>`: without it S3 answers a read
of a missing key with 403 instead of 404, so a deleted file reads as a storage
error rather than not found. Uploads send the signed size as
`Content-Length`, so a body that does not add up is refused by the service.
With an endpoint set, request/response checksums are only computed when an
operation requires them, which keeps MinIO and R2 happy.

`gcs` and `s3` are the path to **more than one replica**: every gateway
instance reads and writes the same bucket, so the gateway Deployment can scale
and needs no volume. The SDK of the store in use is loaded on first use; the
other is never loaded.

## Run locally

Build the engine once at the repository root (`npm ci && npx turbo build
--filter=@relaycast/engine`), then start the actors and the gateway:

```sh
# Actors: `durable-actors dev` on 127.0.0.1:7100, project id `local`
RELAYCAST_PUBLIC_URL=http://127.0.0.1:8787 RELAYCAST_FILE_SIGNING_SECRET=dev-file-signing-secret-0123456789 \
  npm run dev -w @relaycast/actors-workspace

# Gateway, in a second terminal
npm run build -w @relaycast/actors-gateway
DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:7100 DURABLE_ACTORS_PROJECT_ID=local \
RELAYCAST_FILE_SIGNING_SECRET=dev-file-signing-secret-0123456789 \
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
