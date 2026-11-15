# Release preparation for delivery confirmation (#625)

Status: preparation only. Proposed release: **12.10.0** (minor), published through the existing Publish NPM Packages workflow with `custom_version`. No release has been published, tagged, or dispatched by this preparation, and no version, CHANGELOG, or package.json was edited.

Source: relaycast#625 "delivery confirmation", merged to main as `b6cc6e1a57935ddfe36aac33f105ba8d185ee28c` (2026-11-14T22:37:04Z on GitHub; the commit timestamp in git is 22:37:03Z).

## Scope

Sender-facing delivery confirmation. The summary below is deliberately short; the detail lives in two places and is not duplicated here:

- `CHANGELOG.md`, section `## [Unreleased - Minor]`
- `docs/delivery-confirmation.md`

In short:

- One delivery state for senders: `queued | delivered | consumed | replied | failed`.
- `GET /v1/messages/:id/deliveries`, and the state on `POST /v1/dm` and `POST /v1/channels/:name/messages`.
- `wait_ms` (0-2000) on `POST /v1/dm` and channel posts, waiting for the recipient's acceptance.
- `reply_to_message_id` on DMs (and thread replies) marks exactly that delivery `replied`.
- Node frames `delivery.accepted` and `delivery.ack` (per-delivery `delivery_id` form); sender events `delivery.delivered` (with `accepted`), `delivery.acked`, `delivery.replied`.
- `node.register` replies list `capabilities`, so nodes send new frames by capability.
- TypeScript SDK: `agent.messageDeliveries(id)` and `relay.messages.deliveries(id)`, plus the `on.deliveryDelivered` hook (see `packages/sdk-typescript/CHANGELOG.md`).

The Unreleased section also carries other entries merged since 12.8.0 (strict spawn, PostgreSQL self-host, A2A cards, and others); they ship in the same release.

## Repository version state

Every `package.json` (root workspace packages, `packages/*`), `ARG RELAYCAST_ENGINE_VERSION` in the `Dockerfile`, and the `@relaycast/engine` pin and version in `docker/package.json` are **12.8.0** on main. The latest git tag is `v12.8.0`. `CHANGELOG.md` already contains `## [12.8.0] - 2026-11-04` with the pending entries above it.

## npm state and the 12.9.0 anomaly

- `@relaycast/engine`, `@relaycast/types` and `@relaycast/sdk` have `latest` = **12.9.0**, published 2026-11-08T08:15Z from main commit `a14e189e`.
- That publish never committed back: there is no `chore(release): v12.9.0` commit, no `v12.9.0` tag and no GitHub release.
- Every Publish NPM Packages run on 2026-11-08 ended failed. The last (run 42527928805, head `0858d73e`) failed in "Publish engine" with `@relaycast/engine is published with a different artifact integrity`.
- The published 12.9.0 engine tarball has SQLite migrations up to `0082_pending_events_settled_retention.sql`, but **not** `0081_delivery_confirmation.sql`, `0083_strict_spawn_placement_token.sql` or `0084_strict_spawn_dispatch_generation.sql`, and only PostgreSQL migrations `0000_init.sql` and `0001_triggers.sql`.

### Consequence for the dispatch inputs

Dispatching with `version=minor` recomputes 12.9.0 from 12.8.0 and fails the integrity assertion again. Use a custom version.

Proposed inputs (workflow "Publish NPM Packages", ref `main`):

| Input | Value |
| --- | --- |
| `package` | `all` |
| `version` | `minor` (required by the form, ignored because `custom_version` is set) |
| `custom_version` | `12.10.0` |
| `dry_run` | `false` |
| `tag` | `latest` |

### Open question for Khaliq

The simplest path is 12.10.0 via `custom_version`, as above. The alternative is to first reconcile main to 12.9.0 (a `chore(release)` commit recording the already-published 12.9.0) and then publish 12.10.0 from there. This is Khaliq's decision; this document proposes 12.10.0 via `custom_version` and leaves the reconciliation open.

## Migrations shipped by this release

SQLite (`packages/engine/src/db/migrations/`):

- `0081_delivery_confirmation.sql` (the #625 migration)
- `0083_strict_spawn_placement_token.sql` and `0084_strict_spawn_dispatch_generation.sql`, merged after 12.9.0 was published

PostgreSQL (`packages/engine/src/db/migrations-pg/`), none of which are in 12.9.0 (it has only 0000 and 0001):

- `0002_even_silverclaw.sql`
- `0003_previous_lila_cheney.sql`
- `0004_handler_snapshot_backfill.sql`
- `0005_delivery_confirmation.sql` (the #625 migration)

The SQLite migrator is set-based (`packages/engine/src/db/migrationPlan.ts`: sorted files, minus applied, minus supersessions). A host that already applied `0082` from 12.9.0 therefore still applies `0081` when it upgrades to 12.10.0; the gap in numbering is not a problem. `scripts/check-published-engine-migrations.mjs` runs in the workflow's build job and verifies that published migrations are immutable across the dist-tags (`latest`, `next`, `beta`, `alpha`).

## Pre-flight (clean main b6cc6e1a, this worktree, 2026-11-15)

- `npm ci`: ok.
- `npm run test:release`: passed, 0 failures.
- `npm run check:pg-migrations -w packages/engine`: PostgreSQL migrations in sync with `src/db/schema.pg.ts` (6 files).
- `node scripts/check-release-contract.mjs --version 12.10.0 --allow-placeholder-docker-lock` fails before the bump, by design: version parity (packages are still 12.8.0), and with `--version 12.8.0` it reports that `CHANGELOG.md` already contains 12.8.0 but still has pending entries. The workflow runs this check after `npm version` and the lockfile projection, so the failure here is expected and not a defect.

## Dispatch sequence

Every step needs Khaliq's direct ask. The hourly batch flow and the agent host never dispatch publishing.

1. **Publish NPM Packages** on main with the inputs above. Wait for the `chore(release): v12.10.0` commit-back and the GitHub release `v12.10.0`.
2. **Publish Container** on main, at or after that commit, with `tag=12.10.0`, `latest=true`. The workflow refuses a tag that does not equal the `docker/package.json` engine pin (a `<pin>-<suffix>` tag is also accepted), and refuses non-main refs.
3. **relaycast-cloud pin bump PR** (separate repo; runbook `docs/rollouts/engine-12.10.0-delivery-confirmation.md` in that repo). Merging deploys production.

Receipts to collect:

- npm `dist.integrity` and `dist.shasum` for `@relaycast/engine`, `@relaycast/types` and `@relaycast/sdk` at 12.10.0 (`npm view <pkg>@12.10.0 dist.integrity dist.shasum`)
- the workflow run URLs
- the GitHub release URL
- the image digest and its attestation (`gh attestation verify`)

## Live self-host evidence

A test image was built from main `b6cc6e1a` by Publish Container run https://github.com/AgentWorkforce/relaycast/actions/runs/43668851096 with tag `12.8.0-dc625.1` and `latest=false` (engine skeleton from the npm 12.8.0 pin, with `dist` from main overlaid). It is being exercised on live-cast (k3s, chart 0.3.3, SQLite) and then rolled back to the pinned 12.7.0 image.

## Live-cast evidence

_To be filled in by the agent host after the run._

## Gate

Per the agent-host release authority, tagging or publishing npm, publishing the container as a release, and merging or deploying relaycast-cloud each require Khaliq's direct request from his own identity. A request relayed by another agent does not count.
