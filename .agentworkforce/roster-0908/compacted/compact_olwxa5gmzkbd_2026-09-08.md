# Trajectory Compaction: 2026-09-08 - 2026-09-08

## Summary
This short (8-minute) lead session investigated roster read row-visit costs and contention from shared executor queries. The agent measured production traffic showing the old fanout and replay queries averaging in the seconds, then landed a targeted mitigation: a new partial index migration at `packages/engine/src/db/migrations/0051_agent_roster_index.sql`, a row-visit regression harness in `packages/engine/src/__tests__/conformance/agentRoster.test.ts` (dropping visits from 11,018 to 1,016), and supporting edits to `packages/engine/src/db/schema.ts`, `packages/engine/src/engine/agent.ts`, and the compact migration tests. Critically, the fix was scoped narrowly — it does not claim to resolve executor contention or bypass the rollout capacity gate. The bounded replacements for the slow fanout/replay queries live in cloud PR #105, and that dependency is explicitly recorded rather than duplicated locally. API surface and TTL semantics were preserved. Roster + migration test suites (48 tests) plus typecheck and lint all pass. Artifacts captured under `.agentworkforce/roster-0908/` and `docs/agent-roster-latency-389.{md,json}` document the latency analysis. No commits were made in this session; changes remain in the working tree on branch `fix/agent-roster-read-cost`.

## Key Decisions (1)
| Question | Decision | Impact |
|----------|----------|--------|
| How to address roster read cost without overreaching into shared executor contention? | Separate the two problems: land a partial roster index + row-visit regression locally; defer bounded fanout/replay query replacements to cloud PR #105 | Keeps this PR narrowly scoped to an index + regression test (row visits 11,018 → 1,016), preserves API/TTL semantics, and defers to the existing rollout process for the contention fix. |

## Conventions Established
- **Add a row-visit regression test alongside any index-based read-cost fix**: Row-visit counts are a stable, migration-independent signal that a partial index is actually being used; asserting the count (e.g. 11,018 → 1,016) prevents silent regression if the planner or schema drifts. (scope: packages/engine/src/__tests__/conformance/agentRoster.test.ts and similar conformance suites)
- **Record cross-repo rollout dependencies in the PR/analysis notes rather than reimplementing the fix locally**: Bypassing the rollout capacity gate to duplicate a cloud-side fix risks divergence and skips the gating process. Explicit dependency notes keep scopes clean. (scope: Engine PRs that touch queries also being reworked in the cloud repo (e.g. cloud #105))
- **Preserve API surface and TTL semantics when landing performance-only changes**: Index/migration work should be transparent to callers and cache behavior so it can ship independently of feature changes. (scope: packages/engine engine/agent + db layers)

## Lessons Learned
- Distinguish shared-executor contention from avoidable per-query row visits before proposing a fix (Live analytics attributed multi-second latencies to old fanout/replay queries — a systemic contention issue — while the roster read had a separate, index-shaped problem.) - Measure production first, then split the mitigation: fix what you own locally (index + regression) and defer systemic fixes to the owning PR/gate.
- Report scope honestly — do not claim recovery of latencies you did not fix (The session explicitly refused to claim the index resolved executor contention, since cloud #105 is the actual fix for the slow fanout/replay queries.) - PR descriptions and retrospectives should name exactly which metric moved (row visits) and which did not (end-to-end contention latency).

## Open Questions
- When does cloud PR #105 (bounded fanout/replay query replacements) land, and should this engine change wait on it or ship independently?
- Are the docs/agent-roster-latency-389.{md,json} artifacts intended to be committed, or kept as local investigation notes under .agentworkforce/?
- No commit was made — is the intent to bundle 0051_agent_roster_index.sql with the roster test + schema/agent.ts edits in a single PR on fix/agent-roster-read-cost?

## Stats
- Sessions: 1, Agents: default, Files: 0, Commits: 0
- Date range: 2026-09-08T17:30:45.013Z - 2026-09-08T17:38:53.896Z