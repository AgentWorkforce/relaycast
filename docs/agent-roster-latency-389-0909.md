# Roster contention follow-up — September 9, 2026

[#389](https://github.com/AgentWorkforce/relaycast/issues/389) remains unresolved.
The 20:12–20:25 UTC samples reproduce the slow mode and HTTP failures. The
largest 24-hour SQL aggregate is **not contemporaneous evidence** for those
stalls. No production SQL mutation, migration, deployment, or broker restart
was performed.

## Minutes of production requests

| Probe | Samples | Min / median / max seconds | Failures |
| --- | ---: | --- | ---: |
| `agent-relay agent list`, 604-second run | 27 | 1.497 / 2.045 / 60.780 | 0/27 command exits |
| Direct `GET /v1/agents`, five-minute run | 15 | 0.043 / 1.402 / 37.014 | 7/15 HTTP requests (46.7%) |

Five CLI calls exceeded 25 seconds. Command success does not establish HTTP
success: direct requests returned five `503/database_overloaded` responses and
two `500/internal_error` responses. The failed 500s took 37.014 and 28.654 seconds;
the quick 503s make the overall latency median misleading. The two probes ran
at different cadences and partly overlapping times; these are not matched
attempts from the same CLI requests.

The CLI probe made sequential calls separated by ten seconds with a 75-second
per-call timeout. Direct requests used Node fetch, the same configured API and
workspace-key environment, no application retries, a 75-second timeout, and
15-second gaps. Neither probe printed response bodies or credentials. The CLI
payload grew slightly during this live window and its hashes changed; this
sample does not independently reproduce the original byte-identical comparison.
An exploratory Python HTTP client returned immediate non-JSON 403s and was
stopped; those requests are excluded from the table.

The concurrent `relaycast-cloud-api` Worker tail contains D1 CPU-limit resets,
queue overloads, and roster 500s/503s. A small catalog lookup for delivery index
definitions also failed with `D1 DB exceeded its CPU time limit and was reset`
(7429). Its failure does not identify the SQL that caused the reset. A
`retention_prune` job reported overload after 262 ms; that short failed job is
likewise not proof that retention caused the reset.

## Rows scanned, with time attribution

Wrangler 4.130.0 insights were collected through `ssh kjg-lap`, using the database
UUID because name lookup returned an API authentication error. Wrangler's
account listing identifies the supplied account as Agent Workforce. The
required repository-variable cross-check failed with GitHub HTTP 401 on both
machines, so that check is still outstanding.

| Normalized statement | Mean rows read | Total rows read / 24h | Mean SQL ms | Adaptive count |
| --- | ---: | ---: | ---: | ---: |
| Combined delivery `MIN(rowid), MAX(rowid)` | 8,649,746 | 1,037,969,520 | 10,319.5 | 120 |
| Channel fanout with unbounded correlated depth count | 558,375 | 341,167,422 | 5,949.6 | 611 |
| Initial periodic node-redrive joined SELECT | 8,437,739 | 244,694,458 | 25,074.2 | 29 |
| Settled-delivery retention DELETE candidate subquery | 8,409,819 | 201,835,656 | 2,436.2 | 24 |
| Node DELETE with child-key probes | 33,860,603 | 101,581,809 | 95,664.8 | 3 |
| Roster SELECT | 5,756 | 42,018,776 | 70.3 | 7,299 |
| Indexed replay candidate page | 49 | 25,111,674 | 0.73 | 509,604 |

These are database-wide adaptive aggregates, not individual request traces.
The hourly breakdown is decisive for interpreting them:

- All 120 combined min/max observations occur in the **14:00 UTC** bucket.
  Caller attribution remains unknown; the exact query is absent from this
  repository's runtime source. Do not run it against production to investigate.
- The 29 expensive initial-redrive observations occur at September 8 22:00
  and September 9 00:00/08:00 UTC. None in this returned breakdown establishes
  the cause of the current 20:00 UTC stalls.
- A newer 20:00 UTC roster aggregate reads 5,853 rows at 75.75 ms mean SQL time
  while end-to-end calls still take tens of seconds or fail. This supports a
  shared database problem but does not identify its initiating statement.

A final current-hour query sorted by mean SQL duration returned a roster mean
of 84.89 ms as its slowest shape. That result does not explain the concurrent
CPU resets. Do not assume the returned normalized samples identify every failed
or in-flight statement. An account audit-log lookup to investigate external D1
API callers was rejected with HTTP 403; no external caller was identified.

The sampled full SQL, hourly observations, and every probe result are in
[`agent-roster-latency-389-0909.json`](agent-roster-latency-389-0909.json).
Only selected parameterized query shapes are retained; diagnostic queries with
literal workspace identifiers and raw Worker requests are omitted.

## Existing fixes versus a new root-cause claim

The full issue and all ten comments were read, along with the merged diffs:

- #392 bounds reconnect replay with existing sequence/ID indexes and serializes
  overlapping replay scopes. It does not replace periodic redrive or fanout.
- #391 adds node foreign-key indexes, requiring a production migration.
- #390 adds the roster partial index, also requiring a production migration.

Main already replaces the expensive periodic-redrive statement through
`readNodeRedriveCandidates` and migrations 0048/0049. Main also replaces the
unbounded fanout count with capped index branches. The freshly fetched cloud
source at `026d99d` still pins engine `8.5.2-hotfix.2`; source merges alone do not
establish deployment of the mainline indexes. The issue records the promotion's
capacity hold. This investigation does not bypass it or add duplicate indexes.

The added regression in `boundedDatabaseWork.test.ts` measures actual candidate
visits at two history sizes. Production's expiry-before-LIMIT query shape visits
101 or 10,001 rows to return one ID. Main's existing replacement visits one
high-water row plus a 25-row metadata window, independent of that expired
history. It returns an empty first page and resumes via its existing durable
cursor. This verifies the existing fix; it is not a new runtime fix or proof
that deploying it alone eliminates the current incident. All 22 tests in that
file pass; engine lint and typecheck also pass.

## Remaining gates

1. Attribute the contemporary CPU-reset trigger using failed-statement or D1
   executor diagnostics correlated with the saved request timestamps/Ray IDs.
   The largest historical aggregate is insufficient. Cloudflare documents
   [CPU resets as excessive database query work](https://developers.cloudflare.com/d1/observability/debug-d1/),
   including large scans or import/export; that description does not identify
   a caller here.
2. Verify the actual deployed query/index set and resolve the existing safe
   rollout or schema-free backport path. Do not execute full-history probes,
   exports, production mutations, or index migrations under this read-only task.
3. Restore GitHub authentication for the account-variable check and PR creation.
   Public GitHub API reads and Git-over-SSH work; authenticated `gh` calls do not.
   The Cloudflare audit-log endpoint additionally needs working read access.
4. Repeat both long-running probes after an authorized change. Do not close
   #389 while HTTP errors or the 27–70-second mode remain.

Checkpoint posts to `#general` failed with write-capacity, internal-server, and
database-overload errors. A checkpoint DM to the configured broker
`finn-mini-node` was queued successfully; the receipt did not confirm reading.
