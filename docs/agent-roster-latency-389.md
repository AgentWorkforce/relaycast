# Agent roster latency investigation — September 8, 2026

The evidence points to shared D1 executor contention as the dominant explanation
for [#389](https://github.com/AgentWorkforce/relaycast/issues/389), with a separate
avoidable roster scan fixed here. This change does not establish production
recovery or justify reverting the garden's timeout stopgap.

## Read-only production evidence

Cloudflare GraphQL `d1QueriesAdaptiveGroups`, collected around 17:32 UTC for the
preceding hour, returned these database-wide query-shape aggregates. These are
reported analytics averages, not per-request traces or measurements of only the
workspace in the issue. Selected raw aggregates and parameterized SQL are in
[`agent-roster-latency-389.json`](agent-roster-latency-389.json).

| Query shape | Executions | Mean rows read | Mean query duration |
| --- | ---: | ---: | ---: |
| Channel delivery fanout with unbounded depth count | 8 | 3,654,145 | 35,157.9 ms |
| Delivery-first node/provider replay join | 42 | 3,753,184 | 1,932.9 ms |
| Agent roster, workspace and non-released status | 110 | 96 | 1.95 ms |

The fanout shape accumulated 281.3 seconds of query time; replay accumulated
81.2 seconds. A Wrangler D1 information request also failed with
`D1 DB is overloaded. Requests queued for too long. [code: 7429]` during this
investigation. GraphQL analytics remained readable without querying D1 itself.

[D1 executes queries one at a time and queues concurrent requests](https://developers.cloudflare.com/d1/platform/limits/#concurrency-and-throughput).
Multi-second fanout and replay statements therefore explain how an otherwise
small roster query can wait or fail while returning identical data when it
succeeds. We do not have a trace tying each reported slow roster request to a
particular concurrent write. The 1.95 ms aggregate also does not measure the
specific 4.28 MB response's serialization or network cost.

The engine's roster handler already has one SELECT, SQL status filtering, and no
presence UPDATE sweep following #381. Workspace-key authentication reads the
workspace; usage accounting uses the key/value port. Existing query-only HTTP
tests prevent a roster presence-write regression.

## Rollout dependency

At investigation time, `relaycast-cloud` main still pinned engine/types/a2a
8.5.2. The analytics SQL contains the old unbounded depth count and delivery-first
replay join, corroborating that the bounded replacements in engine #386 are not
serving these calls.

[Cloud PR #105](https://github.com/AgentWorkforce/relaycast-cloud/pull/105) holds
the 8.5.4 bounded-query upgrade in draft for production migration capacity review.
Its recorded preflight is 8.98 GB, with worst-case migration growth not cleared.
Coordination alone was deployed through cloud #107; it does not replace those
query shapes. This investigation neither changes that capacity decision nor
deploys migrations. Re-measure fanout/replay scans, roster latency, and overload
rates after the approved rollout before removing the garden timeout stopgap.

## Roster change and deterministic regression

The existing workspace index visits released rows before filtering them out.
Active/online reads also walk stale and unrelated statuses within that workspace.
Migration 0052 adds `(workspace_id, status, last_seen) WHERE status <> 'released'`.
The roster query uses the same literal tombstone predicate so prepared queries
can qualify for the partial index. No forced index hint is needed: an older
schema still serves the query, but only a migrated schema provides the saving.

The HTTP regression uses two workspaces, each containing 10,000 released rows,
1,000 stale active rows, and the existing status/TTL fixtures. A SQLite view with
a non-deterministic predicate counts candidate visits using the actual indexes;
`query_only` rejects writes. It asserts visits, not elapsed milliseconds or
returned-row counts alone.

- Before: unfiltered roster returns 1,016 rows but visits 11,018.
- After: unfiltered roster visits 1,016; active/online visits six; idle/blocked/
  waiting visits two each; released and unknown visit zero.
- Existing fractional TTL boundaries, future timestamps, effective offline
  status, workspace isolation, and repeated read-only requests remain covered.

The index excludes only released identities, not ordinary offline agents. An
unfiltered response still necessarily reads and serializes every roster member.
Offline filtering can still walk other non-released statuses because its derived
status predicate has multiple branches. This is a targeted roster scan reduction,
not a solution for the executor time consumed by the deployed fanout/replay SQL.
