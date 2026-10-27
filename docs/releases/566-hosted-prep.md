# Release preparation for hosted scan fixes

Status: preparation only. Proposed release: **10.6.4** (patch after 10.6.3), subject to release owner devopsgrok confirming the version is still available. No release has been published by this preparation.

Source requirement: the release source must contain `440634bb858f08ffb9ac6da80922c6cbdb2c6c4e` (merged relaycast#566) and `cb4f2704` (merged relaycast#569, which exports `backfillMessageMentionFts` so hosts can drive the 0075 history copy). Hosted currently pins 10.6.3, which does not contain this fix. Keep normal review and CI; Khaliq must explicitly approve merging and publishing. devopsgrok owns the lockstep npm release through the existing Publish NPM Packages workflow. Do not hand-cut changelogs, bump versions ahead of the workflow, or dispatch publishing during preparation.

## Proposed release notes

- Avoid full-history delivery and per-node agent scans that cause shared-database overload.
- Index inbox mentions per workspace after a bounded historical backfill; preserve mention results and retain the fallback until the copy completes.
- Include `X-Request-Id` on engine responses for client error correlation.

## Hosted requirements

Copy these files byte-for-byte from the approved released engine into the hosted applied migration directory:

1. `0074_delivery_active_location_node_index.sql`: partial active-delivery index required by `INDEXED BY`.
2. `0075_message_mention_fts.sql`: workspace-scoped FTS table, insert/update/delete triggers, and `mention-fts-backfill` cursor. No historical rebuild in DDL.

Both migrations must succeed before updating the worker. The cloud PR must update root and worker pins, a registry-generated lockfile with real artifact integrity, and the worker's bundled-engine marker. Until npm publishes the approved version, a final lockfile and engine validation are blocked; never invent artifact hashes or substitute a local build for the released package.

The hosted runbook lives in `AgentWorkforce/relaycast-cloud` at `docs/rollouts/566-database-overload.md`. Merging there triggers production deploy, so its approval must explicitly cover that consequence. Production migration execution and worker promotion each require Khaliq's explicit OK. No credential, security-policy, or gate changes belong in this rollout.
