# Relaycast on Terse

Run the relaycast engine on [Terse](https://docs.useterse.ai) durable actors:
one actor per workspace, each with its own SQLite database, behind a small
stateless gateway.

```
client ──HTTP──▶ gateway (gateway/server.ts)
                  ├─ POST /v1/workspaces ──▶ Workspace[<new snowflake>].create(request, tag)
                  ├─ Bearer ar_<kind>_<wsid>_<tag>_<secret><crc> ──▶ tag verified ──▶ Workspace[workspace id].handle
                  └─ /_relayfiles?token=… ──▶ files on the gateway's disk
```

| Path | What it is |
|---|---|
| `actor/src/workspace.ts` | The `Workspace` actor: `createActorRuntime` from `@relaycast/engine/adapters/actor` on the actor's database and alarm |
| `gateway/server.ts` | Bun server: routes by the workspace id in each credential, calls actors with `terse-sdk`, serves signed file URLs (PUT, GET, HEAD stat, DELETE) from its disk |
| `gateway/server.test.ts` | `bun test`: signed uploads are held to the signed size, deletes, and forged or legacy credentials refused without an actor call |
| `gateway/drive.ts` | End-to-end check: `ar_` keys, refused typo / forged tag / legacy key, workspace, agents, channel post and read, DM, inbox, search, a rolled-back write group, file upload, completion and download |

How it behaves:

- Workspace ids are plain snowflakes. At create the gateway signs the
  workspace's routing tag with its keyring (`RELAYCAST_CREDENTIAL_KEYRING`)
  and hands it to the actor, which puts it in every credential it mints:
  `ar_ws_…`, `ar_ag_…`. The gateway reads the workspace from a credential,
  checks its checksum and verifies its tag before calling an actor, so a typo
  or a credential naming a workspace this keyring never tagged is refused
  without creating an actor. The actor still verifies every credential against
  its own tables.
- The actor accepts only `ar_` credentials: legacy `rk_live_` / `at_live_` …
  credentials get 401 even past the gateway, it serves no
  `POST /v1/credentials/upgrade`, and its responses carry no deprecation
  headers (its workspaces never had legacy credentials).
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
  RELAYCAST_CREDENTIAL_KEYRING='{"current":"a","keys":{"a":"dev-credential-tag-secret"}}' bun run start

# Drive it
bun gateway/drive.ts
```

Point any relaycast client at `http://127.0.0.1:8787` with the `ar_ws_…` key
the drive script prints.

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
`RELAYCAST_FILE_SIGNING_SECRET`, and `RELAYCAST_CREDENTIAL_KEYRING`
(`{"current":"a","keys":{"a":"<secret>"}}`). Credentials outlive key changes,
so rotation adds a key version and makes it current, and never drops one: a
tag verifies with the version it names. Removing a version locks out every
credential tagged under it.
