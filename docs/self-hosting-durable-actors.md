# Self-hosting Relaycast on TerseAI durable-actors

The single-process self-host (`docs/self-hosting.md`) keeps every workspace in
one SQLite file behind one Node process. This deployment splits that into one
[durable-actors](https://github.com/TerseAI/durable-actors) `Workspace` actor
per workspace, each with its own SQLite, behind any number of stateless
gateway replicas. It is what the local proof in this repository exercises; it
is not yet release-grade (see [Least-privilege credential](#least-privilege-credential)
and [Limitations](#limitations)).

## Architecture

```
clients ──HTTP/WS──▶ gateway replicas (Node, stateless)
                      │  POST /v1/workspaces ─────────▶ Workspace[<snowflake>].create(request, tag)
                      │  Bearer ar_<kind>_<wsid>_<tag>_… ▶ tag verified ──▶ Workspace[wsid].handle(request)
                      │  /v1/ws, /v1/node/ws ──────────▶ handle(upgrade probe) ─▶ socket grant ─▶ find-websocket
                      │                                   ─▶ bridged to the actor socket at the control plane
                      │  /_relayfiles?token=… ──────────▶ file store (local dir, or gcs/s3 when implemented)
                      ▼
            durable-actors control plane ──▶ Workspace actors (engine on the actor's SQLite)
```

- **Gateway** (`packages/actors-gateway`): holds no workspace state. An `ar_`
  credential names its workspace; the gateway verifies the credential's
  routing tag with its keyring, then invokes that workspace's actor. It bridges
  WebSockets to actor sockets, re-polls `GET /v1/deliveries?wait=`, and moves
  file bytes for the signed `/_relayfiles` URLs the actors mint.
- **Control plane**: durable-actors 0.14.6. Owns actor placement, the actor
  SQLite databases and the actor-side WebSockets (`find-websocket`,
  `/v1/socket`). Locally this is `durable-actors dev`; in production the hosted
  (GKE) control plane.
- **Workspace actor** (`packages/actors-workspace`): `@relaycast/engine`'s actor
  adapter on the actor's database. `create` for `POST /v1/workspaces`, `handle`
  for every other request, `onConnect`/`onMessage`/`onDisconnect` for realtime,
  `onAlarm` for webhooks, A2A egress and maintenance.
- **Files**: actors never see file bytes. They sign `/_relayfiles` URLs against
  `RELAYCAST_PUBLIC_URL` with `RELAYCAST_FILE_SIGNING_SECRET`; whichever gateway
  replica receives the PUT/GET verifies the token and talks to the file store.

Credentials are the `ar_` family only (`ar_ws_` workspace keys, `ar_ag_` agent
tokens, `ar_nd_` node tokens, `ar_ob_` observer tokens, `ar_wh_` webhooks).
Legacy `rk_live_`/`at_live_`/`ot_live_` credentials are refused with 401 by
the gateway before any actor call.

## Environment contract

One source of truth per process; this page only says who must agree with whom.

| Process | Documented in |
|---|---|
| Gateway | [`packages/actors-gateway/README.md`](../packages/actors-gateway/README.md) ("Environment") |
| Workspace actor | [`packages/actors-workspace/README.md`](../packages/actors-workspace/README.md) ("Environment") |
| Deployer (`deploy/deploy.ts`, registers the actor bundle with a hosted control plane) | [`packages/actors-workspace/README.md`](../packages/actors-workspace/README.md) ("Deploy to a self-hosted control plane") |

Values that must match across processes:

- `RELAYCAST_FILE_SIGNING_SECRET`: actor (signs) and every gateway replica (verifies).
- `RELAYCAST_PUBLIC_URL` (actor) must be the origin clients reach the gateways
  on; signed file URLs embed it.
- `RELAYCAST_INTERNAL_SECRET`: actor and gateway, when `/internal/*` is enabled.
- `DURABLE_ACTORS_CONTROL_PLANE_URL`, `DURABLE_ACTORS_PROJECT_ID`,
  `DURABLE_ACTORS_SECRET`: gateway and deployer point at the same project with
  the same credential (locally: `http://127.0.0.1:7100`, `local`, no secret).
- `RELAYCAST_CREDENTIAL_KEYRING`: identical on every gateway replica, or a
  credential minted through one replica is refused by another.
- `RELAYCAST_FILE_STORE` / `RELAYCAST_FILE_DIR`: identical on every replica;
  with `local` the directory itself must be shared (see [More than one replica](#more-than-one-replica)).

## Running the local proof

```sh
npm ci && npx turbo build --filter=@relaycast/engine
npm run build -w @relaycast/actors-gateway
export PATH="$HOME/.bun/bin:$PATH"          # durable-actors' CLI runs on Bun
npx tsx packages/actors-gateway/e2e/local.ts
```

`local.ts` starts `durable-actors dev` for `packages/actors-workspace` (the
native control-plane binary is downloaded into `~/.cache/durable-actors` on the
first run), two gateways on 8787 and 8788 sharing one file directory, runs
`packages/actors-gateway/e2e/smoke.ts`, and stops everything (SIGTERM, SIGKILL
after 10 s). Exit code 1 on any failed check. State, files and logs go to a
temporary directory removed on success (`--keep-state` uses
`packages/actors-workspace/.durable-actors` instead); ports are overridable with
`RELAYCAST_E2E_CONTROL_PLANE_PORT`, `RELAYCAST_E2E_GATEWAY1_PORT`,
`RELAYCAST_E2E_GATEWAY2_PORT`. Set `DURABLE_ACTORS_SECRET` to run the control
plane with authentication on. `--with-e2e` and `--with-e2e-actions` also run
`scripts/e2e.ts` and `scripts/e2e-actions.ts` against gateway 1 (reported, not
counted; parts of them assume legacy credentials).

The smoke, with the unmodified TypeScript SDK:

1. `POST /v1/workspaces` through gateway 1 answers an `ar_ws_` key.
2. `alice` connects through gateway 1 and `bob` through gateway 2 over
   `/v1/node/ws`; a DM each way arrives on the other's socket.
3. An observer socket (`/v1/ws`, `ar_ob_` token) on gateway 2 receives
   `message.created` for a post made through gateway 1.
4. A file uploaded through gateway 1's signed URL downloads through gateway 2.
5. Gateway 1 is restarted while alice is connected through it: her SDK client
   reconnects on its own, bob's socket on gateway 2 and the observer socket
   never drop, and a second exchange succeeds.
6. `GET /v1/deliveries?wait=` through gateway 1 holds while empty and returns
   as soon as a delivery arrives.

## Realtime semantics

- **Socket grant.** An actor cannot answer 101: the gateway owns the client
  WebSocket. The actor authenticates the upgrade and answers 200 with
  `x-relaycast-socket-grant: 1` and the socket's principal (node or observer
  token id); the gateway opens an actor socket with that principal as metadata
  and bridges frames both ways. The actor re-checks the principal in
  `onConnect`, so a revoked observer token or a deleted node cannot attach.
- **Close codes.** durable-actors passes 1000 and 3000–4999 through; the
  engine's standard codes move to 4000 + their last three digits (1008 → 4008).
  - `4012`: the actor restarted and lost its socket registry; the socket is
    closed on the next call and the client reconnects. The engine also
    rehydrates known sockets from the control plane, so a socket that survived
    the restart is kept rather than closed.
  - `1012 gateway restarting`: a gateway replica received SIGTERM. Only the
    clients bridged through that replica are affected; sockets on other
    replicas, and the actor sockets at the control plane for them, stay up.
  - `1012` from the control plane itself (a controller restart) passes through.
  - `4401`: the principal no longer authenticates; `4400`: malformed principal.
- **Clients reconnect.** The TypeScript SDK's `WsClient` reconnects on any
  server-side close with exponential backoff (1 s base, jittered, 30 s cap),
  re-sends its node registration and resyncs; the proof observes a reconnect
  about half a second after the gateway comes back. Clients using a raw socket
  must do the same.

## `wait` re-poll

An actor answers `GET /v1/deliveries?wait=<ms>` at once: a waiter inside an
actor call would hold the actor's mailbox. The gateway therefore long-polls on
the client's behalf: it forwards without `wait`, and while the answer is empty
and time remains it sleeps `min(remaining, 750 ms)` and asks again, returning
when a delivery arrives, at the deadline (`wait` ≤ 25000), or when the client
goes away. Latency to a new delivery is therefore up to 750 ms plus one actor
call, not immediate as on the single-process self-host.

## More than one replica

- Gateways are stateless; run as many as you like behind any load balancer
  (no sticky sessions needed; WebSockets stay on the replica that accepted the
  upgrade).
- Every replica must share the file store: `RELAYCAST_FILE_STORE=gcs` or `s3`
  (see `packages/actors-gateway/README.md` for the bucket env and IAM).
  `local` with a shared directory is only the approximation the local proof
  uses; it needs one writer and an RWO volume in a real deployment.
- Every replica must hold the same keyring and file-signing secret.
- Workspace actors scale with the control plane; one workspace is one actor,
  so a single workspace's throughput is one actor's.

## Least-privilege credential

The gateway authenticates to the control plane with `DURABLE_ACTORS_SECRET`.
Today that is the project's admin key: the same credential the deployer uses
to replace the actor bundle. A compromised gateway could therefore redeploy
the actor code. durable-actors needs an invoke-only key (invoke and
`find-websocket`, no deployment or project management) before this is
release-grade; until that patch lands, treat the gateway as holding the admin
key and restrict its network and secret exposure accordingly. Locally
(`durable-actors dev`) there is no key unless you set `DURABLE_ACTORS_SECRET`.

A durable-actors patch adding `DURABLE_ACTORS_INVOKE_API_KEY` (accepted only on
`invoke`, `find-actor` and `find-websocket`) is being carried alongside this
branch; with it, the gateway's `DURABLE_ACTORS_SECRET` is that invoke key and
only the deployer holds the admin key. What the invoke key still trusts:

- **`find-websocket` is full trust for sockets.** The socket ticket carries
  caller-chosen metadata, and the actor's `onConnect` treats it as the
  authenticated principal. The gateway therefore sets metadata only from the
  socket grant the actor itself returned after authenticating the client's
  token (`x-relaycast-socket-grant`), never from anything the client sent; the
  actor additionally re-validates the principal (strict schema, its own
  workspace id, node or observer token re-read from its database) before
  attaching the socket.
- The key is instance-wide, not scoped to one project.
- The control plane does not warn when the invoke key is set while auth is
  off (`DURABLE_ACTORS_SECRET` unset): auth-off means every caller is admin.

## Limitations

- **Lookups by workspace name do not work.** The gateway routes only by the
  workspace id inside a bearer `ar_` credential and keeps no name index, so
  unauthenticated by-name endpoints (`GET /.well-known/agent-card.json?workspace=<name>`,
  `GET /v1/workspaces/by-name/:name`) answer 401 instead of 200.
- **Legacy credentials are refused** (`rk_live_`, `at_live_`, `ot_live_`), and
  so is credential upgrade from them; clients must use the `ar_` family.
- **First call to a new workspace is slow**: `POST /v1/workspaces` cold-starts
  an actor and runs the engine migrations (about 9 s under `durable-actors
  dev`); later calls on a warm actor take tens of milliseconds.
- **`gcs`/`s3` file stores are unit-tested against fakes only** on this branch;
  the first run against a real bucket is the integration test.
- **`wait` is polled** at 750 ms granularity (above).
- **No actor-restart drill locally**: `durable-actors dev` exposes no restart
  API, so the proof restarts a gateway, not an actor; the 4012 path is covered
  by the engine's actor-adapter unit tests (`npx vitest run src/adapters/actor`
  in `packages/engine`).
- **Admin key on the gateway** (above).
- The repository's `scripts/e2e.ts` and `scripts/e2e-actions.ts` partly assume
  legacy credentials (`scripts/action-wait-ws.ts` insists on `ot_live_`
  observer tokens) and the by-name agent card, so they report those steps as
  failures against this deployment by construction.
