# Relaycast on Terse

Run the relaycast engine on [Terse](https://docs.useterse.ai) durable actors:
one actor per workspace, each with its own SQLite database, behind a small
stateless gateway.

```
client ──HTTP──▶ gateway (gateway/server.ts)
                  ├─ POST /v1/workspaces ──▶ Workspace[<new id>].create
                  ├─ Bearer relaycast_<kind>_<workspace_id>_<secret> ──▶ Workspace[workspace_id].handle
                  └─ /_relayfiles?token=… ──▶ files on the gateway's disk
```

| Path | What it is |
|---|---|
| `actor/src/workspace.ts` | The `Workspace` actor: `createActorRuntime` from `@relaycast/engine/adapters/actor` on the actor's database and alarm |
| `gateway/server.ts` | Bun server: routes by the workspace id in each credential, calls actors with `terse-sdk`, serves signed file URLs (PUT, GET, HEAD stat, DELETE) from its disk |
| `gateway/server.test.ts` | `bun test`: signed uploads, chunked or not, are held to the signed size |
| `gateway/drive.ts` | End-to-end check: workspace, agents, channel post and read, DM, inbox, search, a rolled-back write group, file upload, completion and download |

How it behaves:

- The gateway mints workspace ids with an HMAC tag
  (`<snowflake><key version><tag>`) and verifies it before calling an actor, so
  a credential naming a workspace it never minted is refused without creating
  an actor.
- Workspaces created here issue self-routing credentials
  (`relaycast_ws_…`, `relaycast_ag_…`), so the gateway finds the workspace
  without a lookup. The actor still verifies every credential against its own
  tables.
- The actor runs on durable-actors 0.14.5. Each actor call is one SQLite
  transaction, and each engine write group nests inside it
  (`db.transaction`), so a failed group rolls back alone and the request goes
  on, as on the Node adapter.
- Outbound HTTP (webhooks, http_push nodes, A2A egress retries) runs from the
  actor alarm, never while a request holds the actor. A DM to an external A2A
  agent is still sent inline, bounded by its 15s timeout.
- Each maintenance step runs in its own nested transaction. A step or write
  group that fails rolls back alone and is reported to telemetry
  (`alert: 'maintenance_rolled_back'`, with workspace, step, write group and
  error code); the rest of the pass commits, and the alarm re-arms for the
  next outstanding deadline.
- WebSocket endpoints (`/v1/ws`, `/v1/node/ws`) are not served by this example.

## Run locally

Requires [Bun](https://bun.sh) 1.4.2+.

In this repository both packages link the engine from `packages/engine`;
build it first (`npm ci && npx turbo build --filter=@relaycast/engine` at the
repository root). Outside it, and for `terse deploy` (which uploads only
`actor/`), depend on the published `@relaycast/engine` instead.

```sh
# Actors (`durable-actors dev` on 127.0.0.1:7100): state persists in actor/.durable-actors/
cd actor && bun install
RELAYCAST_PUBLIC_URL=http://127.0.0.1:8787 RELAYCAST_FILE_SIGNING_SECRET=dev-secret bun run dev

# Gateway, in a second terminal
cd gateway && bun install
RELAYCAST_FILE_SIGNING_SECRET=dev-secret \
  RELAYCAST_WORKSPACE_ID_KEYRING='{"current":"a","keys":{"a":"dev-workspace-id-secret"}}' bun run start

# Drive it
bun gateway/drive.ts
```

Point any relaycast client at `http://127.0.0.1:8787` with the `relaycast_ws_…`
key the drive script prints.

The gateway keeps file bytes on its own disk (`RELAYCAST_FILE_DIR`), so run a
single instance on persistent storage, or point `serveFile` at a shared object
store.

## Deploy to Terse

The actor depends on `durable-actors` 0.14.5 and on `terse-cli` / `terse-sdk`
0.14.8 (dev dependencies), which pin the same durable-actors, so the project
holds one copy. `terse deploy` uploads the `actor/` source and discovers its
actors through the project's `terse-sdk`. On an older hosted runtime,
`createActorRuntime` throws `the relaycast actor adapter requires
durable-actors >= 0.14.5`.

```sh
cd actor
terse init --non-interactive        # or `terse attach` for an existing project
terse secrets add RELAYCAST_FILE_SIGNING_SECRET
terse secrets add RELAYCAST_PUBLIC_URL   # your gateway's public origin
terse deploy                         # prints TERSE_ACTOR_URL
```

Run the gateway anywhere with `TERSE_ACTOR_URL`, `TERSE_API_KEY`, the same
`RELAYCAST_FILE_SIGNING_SECRET`, and `RELAYCAST_WORKSPACE_ID_KEYRING`
(`{"current":"a","keys":{"a":"<secret>"}}`). Workspace ids are permanent, so
rotation adds a key version and makes it current, and never drops one: an id
verifies with the version it names. Removing a version locks out every
workspace minted under it.
