# Stale-node scaling and enrollment evidence — September 10, 2026

**Node roster work grows linearly with retained workspace rows. The proposed
enrollment → stale records → overload feedback loop is not yet established.**
Pruning would reduce roster work, but these measurements do not establish that
it would restore enrollment or eliminate #389's CPU resets.

The investigation follows the supplied Daytona enrollment evidence. It uses
synthetic local databases, bounded D1 analytics, direct HTTP roster reads, and
read-only inspection of one fleet-labelled sandbox. No production SQL,
pruning, index migration, deployment, or merge was performed. Sanitized results
are in [the evidence JSON](agent-roster-scaling-389-0910.json).

## Distinguish the two rosters

The new 6,274-hidden-record lead concerns **nodes**, `/v1/nodes`. The September 9
46.7% HTTP failure sample concerned **agents**, `/v1/agents`; its 75.75 ms SQL
aggregate must not be presented as a node-roster measurement.

`packages/engine/src/engine/node.ts:listNodes` selects every node in a workspace,
including offline and direct nodes. Name and capability filters run in JS after
the SELECT. The inspected cloud caller, `listFleetNodesForAppWorkspace` in
`packages/web/lib/fleet/nodes.ts`, requests `/v1/nodes` and hides history after
receiving the response. UI-hidden records therefore still incur SQL, hydration,
serialization, and transfer costs. The existing agent retention feature (#401)
does not prune this node table.

## Controlled row-count experiment

Run `npx tsx scripts/measure-roster-scaling.mts`. It creates only in-memory
SQLite databases, applies repository migrations, and invokes the real engine
read functions. Each database has 13 live rows plus varying offline history in
both the measured workspace and an equally sized unrelated control workspace.
Nondeterministic predicates in indexed views count candidate visits; reads run
with `query_only` enabled. Each scenario has one warmup and seven measurements.
Assertions check result counts and visits, never elapsed time.

| Stale rows in measured workspace | Node roster visits | Node roster median local ms | Name-filtered list visits | Direct node-detail visits | Active-agent visits |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 13 | 0.17 | 13 | 1 | 13 |
| 100 | 113 | 0.50 | 113 | 1 | 13 |
| 1,000 | 1,013 | 4.03 | 1,013 | 1 | 13 |
| 6,274 | 6,287 | 25.39 | 6,287 | 1 | 13 |
| 12,548 | 12,561 | 48.87 | 12,561 | 1 | 13 |

Capability-filtered lists also visit every workspace node. Unfiltered agent
lists grow linearly with offline agents; active-agent lists remain bounded by
their existing roster index in this local mainline schema. This does not verify
that production has that index. The node-detail control demonstrates that
history size does not make every enrollment-related lookup expensive.

The local node response grows from 5,298 to 2,489,802 bytes with 6,274 stale
rows. Removing those synthetic stale rows reduces candidate visits by 99.79%.
These are synthetic comparisons, **not production deletion results**. Timings
include instrumented SQLite execution, JS hydration, and JSON serialization;
they exclude D1 queueing, Worker overhead, and network transfer. No superlinear
roster cost appears in this experiment.

## Same-window production SQL and HTTP

D1 GraphQL returned HTTP 200 with no GraphQL errors for September 10,
20:10:00–20:40:16 UTC. The request selected the top 50 normalized shapes by
total rows read. Relevant returned shapes:

| Shape | Adaptive count | Mean rows read | Mean SQL ms | Total SQL seconds |
| --- | ---: | ---: | ---: | ---: |
| Full node roster by workspace | 1,317 | 6,278 | 44.59 | 58.72 |
| Full agent roster, excluding released | 1,057 | 5,049 | 72.79 | 76.94 |
| Agents by node/provider, ordered by name | 1,153 | 6,023 | 19.01 | 21.92 |
| Node lookup by workspace/id | 9,433 | 1 | 0.35 | 3.28 |
| Node lookup by workspace/name | 6,306 | 0* | 0.44 | 2.80 |

*The API reports integer mean rows read of zero for the name lookup; its total
is 6,072 rows read/returned. This is not evidence of zero-cost lookups.*

These are database-wide adaptive aggregates, not individual traces. The node
roster's summed SQL time is about 3.2% of the 1,816-second window; this ratio is
not measured executor utilization and cannot rule out short bursts, failed
queries omitted from analytics, or other competing statements. The node/provider
agent scan is additional retained-agent work, not a new CPU-reset attribution.

Direct fetches alternated between the two endpoints over 20:35:42–20:40:35 UTC:

| Endpoint | Samples | Min / median / max seconds | HTTP or envelope failures |
| --- | ---: | --- | ---: |
| `/v1/nodes` | 6 | 0.819 / 1.263 / 1.484 | 0/6 |
| `/v1/agents` | 6 | 1.124 / 1.633 / 2.292 | 0/6 |

Calls were sequential, with 25-second gaps, a 75-second timeout, and no
application retries. All returned HTTP 200 and `ok: true`; request timestamps,
Ray IDs, bytes, and counts are retained. One additional inventory-join roster
read returned HTTP 200; it is recorded separately from this scheduled sample.
Node responses still carried 6,288–6,289 rows and about 3.66 MB. At 20:37:28,
6,274 were offline. The last node response reported only five live nodes,
down from 14–15 in earlier samples, despite HTTP success.

The table can therefore coexist with a healthy HTTP window. That does **not**
disprove retained rows as a load amplifier, nor erase the prior 27–70-second
mode. No intervention preceded this sample, and six observations per endpoint
cannot establish recovery. #389 remains open.

## Enrollment attribution remains incomplete

A bounded Daytona first page at 20:38:15 UTC contained 44 started/creating
sandboxes: 15 labelled `source=agent-relay-fleet-node`, 20 `source=workflow`,
eight carrying a step label without a source, and one `purpose=workforce-deploy`.
There was another page; this is not an exhaustive inventory. CLI JSON exposed
no HTTP status, which is recorded as unknown rather than inferred from exit 0.
Comparing **all** running sandboxes to fleet nodes cannot establish 31 failed
fleet enrollments. Ownership and expected enrollment behavior must be joined
first. An attempted join using sandbox IDs in node tags found no matches but
did not establish those tags were present; it is inconclusive.

One fleet-labelled sandbox created at 20:24:13 UTC was inspected around
20:39–20:41. Its process-name listing had no relay or node process. The bounded
session-log inspection found an entrypoint log, five mkdir logs, and five
verify-upload logs, all empty. The daemon-log tail had no enrollment,
`/v1/nodes`, overload, or timeout markers. This establishes neither a failed
registration HTTP call nor that registration was never attempted. Source shows
preparation work occurs before the cloud-enroll command, so a pre-enrollment
stall must remain a competing explanation. No command was rerun to enroll,
restart, or otherwise change that sandbox.

## Mitigation decision and remaining gate

Only the **stale rows → more roster work** edge is measured. Neither **failed
enrollment → these stale rows** nor **extra roster work → CPU reset/failed
enrollment** is traced. A pruning proposal must identify eligible stale nodes
and their dependent records; a UI-hidden count is not deletion eligibility.
Do not infer that deleting thousands of nodes is cheaper than the read path:
the prior incident already contains costly node-deletion evidence. No pruning
is recommended as a proven recovery mechanism on this evidence.

For a caller waiting for one known node, the existing detail endpoint has a
measured one-row local lookup and production name-lookup SQL averages 0.44 ms.
Using it is a bounded-read candidate for separate implementation and caller
validation; a `?name=` list request currently still materializes all nodes.

The audit retry at 20:35:14 UTC again returned HTTP 403, code 10000, for the
saved September 9 failure window. The repository account variable matches
Agent Workforce. Cloudflare documents **Account Settings Read** as sufficient
for [account audit-log access](https://developers.cloudflare.com/api/resources/accounts/subresources/logs/subresources/audit/methods/list/).
No alternate access path was attempted after denial. Gate 1 still needs a
failed-statement/executor diagnostic correlated to the saved failure Ray IDs,
plus a captured failing sandbox enrollment request before attributing the
garden outage to that mechanism.

PR #417 was already based on current `origin/main` (`801d70a5`) at head
`90f90d4c`, with successful required checks, clean mergeability, and no review
threads. Its reviewed head is preserved; these new artifacts are local for
review. The scaling script passed all 210 measured assertions of each kind;
the existing agent-roster suite passed 37 tests and bounded-database-work suite
passed 22 tests. No duplicate PR or merge was created.
