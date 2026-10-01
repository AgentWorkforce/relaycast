# Companion change needed in the Relay CLI repo for #422

This repository (`relaycast`/`@relaycast/engine` + `@relaycast/sdk`) now exposes
the server-side pieces `AgentWorkforce/relay#1689` needs, but per scope this PR
does **not** touch the Relay CLI repository (`AgentWorkforce/relay`,
`packages/cli/src/cli/commands/fleet.ts`). That repo needs its own follow-up
PR making these two calls.

## What changed here

- `GET /v1/nodes?status=online` now pushes the liveness selector into SQL and
  returns only fresh-heartbeat live nodes — the same shape (`data: [...]`)
  Relay already parses, just without the offline/history rows.
- `GET /v1/nodes?history=true&cursor=&limit=` returns
  `{ nodes: [...], next_cursor }`, a bounded page of the full roster (any
  status), ordered by `id`, that never truncates: keep paging while
  `next_cursor` is non-null.
- Every roster entry now carries `active_agents_stale` (`true` once a node is
  offline). `active_agents` on an offline row is frozen history, not current
  occupancy.
- `@relaycast/sdk`: `relay.nodes.list({ status: 'online' })` for the live path;
  `relay.nodes.listHistory({ cursor, limit })` for bounded, paginated history.

## Required Relay CLI change (`packages/cli/src/cli/commands/fleet.ts`)

1. **Default `fleet nodes` / `fleet agent list`** (today, per the issue, calls
   `relay.nodes.list()` unfiltered and hides `offline`/non-fleet rows locally):
   change the default call to `relay.nodes.list({ status: 'online' })` (or the
   equivalent raw `GET /v1/nodes?status=online`). Drop the local
   `6294 offline or non-fleet records hidden` message for the default path —
   it should no longer be true, since the server never returns those rows.
   Keep any remaining local capability/name filtering; those params still work
   unchanged (now pushed into SQL server-side).

2. **`--all` (explicit history)**: replace the single unbounded
   `relay.nodes.list()` call with a loop over `relay.nodes.listHistory()`,
   following `nextCursor` until it is `null`:

   ```ts
   const rows: NodeRosterEntry[] = [];
   let cursor: string | null | undefined;
   do {
     const page = await relay.nodes.listHistory({ cursor, limit: 200 });
     rows.push(...page.nodes);
     cursor = page.nextCursor;
   } while (cursor);
   ```

   This bounds each request/response instead of the previous single
   6,298-row / ~3 MB fetch, while still returning every row to `--all` with no
   truncation.

3. **`active_agents` display**: when rendering `--all`/history rows, use
   `node.activeAgentsStale` to avoid presenting a frozen offline count as
   current occupancy — e.g. render it as `active_agents (stale)` or omit it,
   rather than as a live number.

None of this requires a Relaycast API version bump gate: `status`, `history`,
`cursor`, `limit`, and `active_agents_stale` are additive query parameters and
an additive response field, so an unmodified Relay CLI keeps working exactly
as before against this engine version.
