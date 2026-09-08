# Node deletion D1 scans (September 8, 2026)

D1 insights for `relaycast-cloud`, collected with Wrangler 4 over SSH on
September 8, identify another source of shared-executor contention after the
workspace-event allocation fix. These are **rows read**, not rows returned.

| Statement shape | Executions / 24h | Average rows read | Total rows read | Average duration |
| --- | ---: | ---: | ---: | ---: |
| Provider-scoped pending fleet replay join | 16,755 | 3,306,863 | 55,406,502,549 | 1,269 ms |
| Guarded implicit node DELETE during agent release | 34 | 30,856,258 | 1,049,112,804 | 11,410 ms |
| `DELETE FROM nodes WHERE id = ?` | 2 | 30,525,551 | 61,051,102 | 35,250 ms |

The guarded DELETE is emitted by `dispatchRelease` in
`packages/engine/src/engine/action.ts`. Its outer predicate selects a node by
workspace and ID, with completed-invocation and current-agent existence guards.
SQLite then probes child foreign keys, independently of those outer guards.
`deleteAgent` in `engine/agent.ts` also removes its implicit node by ID.

Each `REFERENCES nodes(id)` probe needs a child-key lookup equivalent to
`SELECT rowid FROM deliveries WHERE location_node_id = ?` (and separately
`route_node_id = ?`). Without a node-ID-leading index, deleting even a node
with **no matching delivery** scans retained deliveries in every workspace.
Workspace-leading or active-status-only indexes cannot guarantee this lookup.
The same gap exists for agent location/origin, bindings, and providers.

Migration 0051 adds six narrow child-key indexes. Nullable keys exclude NULL
entries but include all statuses. No history is removed, and foreign keys and
uniqueness constraints are unchanged. Work scales with children of the deleted
node; a node with many actual children still requires proportionate writes.

The regression executes identical instrumented FK probes over 10,001 rows
before and after applying the migration: 10,001 -> 1 visits for a matching node,
and 10,001 -> 0 for an empty node. Suppressing the migration makes the new bound
fail (`expected 10001 to be 1`). A second test checks the real DELETE plan and
executes it to verify SET NULL, CASCADE, retained rows, and other-tenant isolation.

## Deployment path

The dominant replay query is already fixed in engine **8.5.3**, included in
**8.5.4** on main. The latest one-hour insights still contained its old shape
(157,633,764 rows read, 3,753,184 per execution). At inspection, both the root
and `packages/relaycast/package.json` in `AgentWorkforce/relaycast-cloud` pinned
engine, types, and a2a to **8.5.2**. This supports contention from older deployed
SQL; it does not implicate a new roster sweep on current main.

This change needs the next engine patch release (expected **8.5.5**, based on
8.5.4), then matching cloud dependency/lockfile pins and migration packaging,
then migration 0051 and a cloud deployment. It also carries the existing replay
fix. Merging this PR alone does not change production. No merge, npm publish,
production DDL, or deployment was performed for this investigation.

The reported 8.58 GiB / 10 GiB storage ceiling is a separate incident risk.
These indexes consume space and index construction occupies the D1 executor.
The cloud rollout's existing capacity gate must include 0051's additional
allocation alongside 0050; the earlier compact-migration estimate does not
include these indexes. See [the compact migration rollout guide](compact-maintenance-migrations.md).
Do not infer available capacity from NULL exclusion alone.

Production EXPLAIN/schema inspection was attempted read-only but failed with
D1 error 7429 (queued too long). The plan and FK-index diagnosis were verified
locally against repository migrations; the statement costs above are production
D1 insights. After rollout, verify statement rows read and actual registration
and roster requests; `/health` does not test database availability.

To reproduce the insights ranking:

```sh
npx --yes wrangler@4 d1 insights relaycast-cloud --time-period 1d --sort-type sum --sort-by reads --limit 30 --json
npx --yes wrangler@4 d1 insights relaycast-cloud --time-period 1h --sort-type sum --sort-by reads --limit 15 --json
```
