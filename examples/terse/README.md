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
| `gateway/server.ts` | Bun server: routes by the workspace id in each credential, calls actors with `terse-sdk`, serves signed file URLs from its disk |
| `gateway/server.test.ts` | `bun test`: signed uploads, chunked or not, are held to the signed size |
| `gateway/drive.ts` | End-to-end check: workspace, agents, channel post and read, DM, inbox, search, a rolled-back write group, file upload/download |

How it behaves:

- Workspaces created here issue self-routing credentials
  (`relaycast_ws_…`, `relaycast_ag_…`), so the gateway finds the workspace
  without a lookup. The actor still verifies every credential against its own
  tables.
- Each actor call is one SQLite transaction. If an engine write group fails
  after writing, the call rolls back and `callWorkspaceActor` calls again with
  that group failing up front; the client gets the response of the pass that
  commits.
- Outbound HTTP (webhooks, http_push nodes, A2A) runs from the actor alarm,
  never while a request holds the actor.
- WebSocket endpoints (`/v1/ws`, `/v1/node/ws`) are not served by this example.

## Run locally

Requires [Bun](https://bun.sh) 1.4.2+.

```sh
# Actors: state persists in actor/.durable-actors/
cd actor && bun install
RELAYCAST_PUBLIC_URL=http://127.0.0.1:8787 RELAYCAST_FILE_SIGNING_SECRET=dev-secret bun run dev

# Gateway, in a second terminal
cd gateway && bun install
RELAYCAST_FILE_SIGNING_SECRET=dev-secret bun run start

# Drive it
bun gateway/drive.ts
```

Point any relaycast client at `http://127.0.0.1:8787` with the `relaycast_ws_…`
key the drive script prints.

In this repository both packages link the engine from `packages/engine`;
build it first (`npm ci && npx turbo build --filter=@relaycast/engine` at the
repository root). Outside it, and for `terse deploy` (which uploads only
`actor/`), depend on the published `@relaycast/engine` instead.

The gateway keeps file bytes on its own disk (`RELAYCAST_FILE_DIR`), so run a
single instance on persistent storage, or point `serveFile` at a shared object
store.

## Deploy to Terse

```sh
cd actor
terse init --non-interactive        # or `terse attach` for an existing project
terse secrets add RELAYCAST_FILE_SIGNING_SECRET
terse secrets add RELAYCAST_PUBLIC_URL   # your gateway's public origin
terse deploy                         # prints TERSE_ACTOR_URL
```

Run the gateway anywhere with `TERSE_ACTOR_URL`, `TERSE_API_KEY` and the same
`RELAYCAST_FILE_SIGNING_SECRET`.
