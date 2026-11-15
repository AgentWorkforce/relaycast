# Release preparation for delivery confirmation (#625)

Status: npm release **12.10.0** published. Khaliq dispatched Publish NPM Packages with `custom_version`; the run succeeded, every package is on npm, and the commit-back, tag and GitHub release exist; see "Dispatch status" below. Khaliq then dispatched Publish Container on the commit-back; it was still running when this note was last updated (2026-11-15T03:28Z). The relaycast-cloud pin bump has not been requested. This note itself edits no version, CHANGELOG, or package.json; the workflow's commit-back did that.

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

Before the release (main `b6cc6e1a`): every `package.json` (root workspace packages, `packages/*`), `ARG RELAYCAST_ENGINE_VERSION` in the `Dockerfile`, and the `@relaycast/engine` pin and version in `docker/package.json` were **12.8.0**. The latest git tag was `v12.8.0`. `CHANGELOG.md` contained `## [12.8.0] - 2026-11-04` with the pending entries above it.

After the commit-back (main `fd10195436054d97c75504d1c803df0d1f2fed98`, `chore(release): v12.10.0`): all of those are **12.10.0**, the tag `v12.10.0` points at that commit, and `CHANGELOG.md` has `## [12.10.0] - 2026-11-15` under an empty `## [Unreleased]`.

## npm state and the 12.9.0 anomaly

State of the registry when this note was written (2026-11-15T02:46Z), before the dispatch recorded under "Dispatch status".

- `@relaycast/engine`, `@relaycast/types` and `@relaycast/sdk` have `latest` = **12.9.0**, published 2026-11-08T08:15Z from main commit `a14e189e`.
- That publish never committed back: there is no `chore(release): v12.9.0` commit, no `v12.9.0` tag and no GitHub release.
- Every Publish NPM Packages run on 2026-11-08 ended failed. The last (run 42527928805, head `0858d73e`) failed in "Publish engine" with `@relaycast/engine is published with a different artifact integrity`.
- The published 12.9.0 engine tarball has SQLite migrations up to `0082_pending_events_settled_retention.sql`, but **not** `0081_delivery_confirmation.sql`, `0083_strict_spawn_placement_token.sql` or `0084_strict_spawn_dispatch_generation.sql`, and only PostgreSQL migrations `0000_init.sql` and `0001_triggers.sql`.

### Consequence for the dispatch inputs

Dispatching with `version=minor` recomputes 12.9.0 from 12.8.0 and fails the integrity assertion again. Use a custom version.

Inputs used for the dispatch (workflow "Publish NPM Packages", ref `main`):

| Input | Value |
| --- | --- |
| `package` | `all` |
| `version` | `minor` (required by the form, ignored because `custom_version` is set) |
| `custom_version` | `12.10.0` |
| `dry_run` | `false` |
| `tag` | `latest` |

### Open follow-up: 12.9.0 is still unreconciled on main

Khaliq chose 12.10.0 via `custom_version` without first reconciling main to 12.9.0. Main therefore still has no `chore(release): v12.9.0` commit, no `v12.9.0` tag and no 12.9.0 CHANGELOG section. That is harmless for 12.10.0, whose commit-back moves the version past 12.9.0. It stays recorded here so that nobody reads the gap as a missing release later.

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

## Dispatch status

Khaliq (`khaliqgant`) dispatched Publish NPM Packages on main `b6cc6e1a` at 2026-11-15T02:49:19Z, run https://github.com/AgentWorkforce/relaycast/actions/runs/43669541261, resolving to **12.10.0**. Do not dispatch the inputs above again: npm refuses a republish of an existing version and the integrity assertion fails.

The run concluded **success** at 2026-11-15T03:22:08Z. All eight publish jobs and "Verify all packages published" succeeded, and every package has 12.10.0. "Create Release" completed at 03:18:04Z: it pushed the commit-back `fd101954` (`chore(release): v12.10.0`, committed in the build job at 02:54:54Z and pushed to main by this job), the tag `v12.10.0` at that commit, and the GitHub release https://github.com/AgentWorkforce/relaycast/releases/tag/v12.10.0 (published 03:18:02Z). The Engine binaries build, smoke and attach jobs then succeeded (14 release assets).

| Package | 12.10.0 published |
| --- | --- |
| `@relaycast/sdk` | 2026-11-15T03:03:07Z |
| `@relaycast/engine` | 2026-11-15T03:05:21Z |
| `@relaycast/types` | 2026-11-15T03:05:58Z |
| `@relaycast/a2a` | 2026-11-15T03:06:27Z |
| `relaycast` (cli) | 2026-11-15T03:11:34Z |
| `@relaycast/react` | 2026-11-15T03:12:26Z |
| `@relaycast/mcp` | 2026-11-15T03:13:00Z |
| `@relaycast/openclaw` | 2026-11-15T03:13:10Z |

npm receipts at 12.10.0 (`npm view <pkg>@12.10.0 dist.integrity dist.shasum`, read 2026-11-15T03:25Z):

| Package | `dist.integrity` | `dist.shasum` |
| --- | --- | --- |
| `@relaycast/engine` | `sha512-DwZVYXsPbpbQfPnnRThky7RvKITq0JnRbV2lmPquaiSR4XKkxrNKRrvsi/nk4VAsw5gREK1mJOifX7q9+kTveg==` | `f50ab9ca8d7a86ef4842fd29ea7f8e0c463ff3ed` |
| `@relaycast/types` | `sha512-onXSI+sqSuqHHF5uUPeR/WFvGpa4hvWQZHmCjjbZrUMjme3Ajo25MrDqRXkJo06g09/ib6pBbrZ7t+2Yvri4cQ==` | `f7ec7e9f92e245aff07bd34350a32e4fbc9c1c3d` |
| `@relaycast/sdk` | `sha512-4IkDmOcZw/z4z/KR9Tw+tUlP9B0yWQ064ukE0iePxOzJiqGeHlxSQUnQkmSOX/rs3emRWTAB7JGkj5Y4zRIoZw==` | `f772660a357b5ec62319a3cede150847919f2f08` |

Container publish: Khaliq dispatched Publish Container on main `fd101954` at 2026-11-15T03:20:04Z, run https://github.com/AgentWorkforce/relaycast/actions/runs/43671881371. At 03:28Z the "Verify the tag matches the pinned engine version" step had passed against the 12.10.0 pin and "Build and push by digest" was running; the tag input, the image digest and the attestation are not readable until the run finishes. Add them to the receipts when it does.

## Dispatch sequence

Every step needs Khaliq's direct ask. The hourly batch flow and the agent host never dispatch publishing.

1. **Publish NPM Packages**: done, including the `chore(release): v12.10.0` commit-back, the `v12.10.0` tag and the GitHub release; see "Dispatch status". Do not dispatch again.
2. **Publish Container** on main at the commit-back, intended inputs `tag=12.10.0`, `latest=true`: dispatched by Khaliq and in progress, inputs not yet confirmable; see "Dispatch status". The workflow refuses a tag that does not equal the `docker/package.json` engine pin (a `<pin>-<suffix>` tag is also accepted), and refuses non-main refs.
3. **relaycast-cloud pin bump PR** (separate repo). Not requested. That repo has no rollout runbook for 12.10.0 yet; its `docs/rollouts/` holds `566-database-overload.md` and `engine-12.8.1-integration-delivery.md`, and no PR there mentions 12.10.0. Merging the pin bump deploys production.

Receipts to collect:

- npm `dist.integrity` and `dist.shasum` for `@relaycast/engine`, `@relaycast/types` and `@relaycast/sdk` at 12.10.0: recorded under "Dispatch status"
- the workflow run URLs: npm run 43669541261 and container run 43671881371, both under "Dispatch status"
- the GitHub release URL: recorded under "Dispatch status"
- the image digest and its attestation (`gh attestation verify`): pending the container run

## Live self-host evidence

A test image was built from main `b6cc6e1a` by Publish Container run https://github.com/AgentWorkforce/relaycast/actions/runs/43668851096 with tag `12.8.0-dc625.1` and `latest=false` (engine skeleton from the npm 12.8.0 pin, with `dist` from main overlaid). It is being exercised on live-cast (k3s, chart 0.3.3, SQLite) and then rolled back to the pinned 12.7.0 image. The live-cast results are not yet recorded; add them to this section when the run finishes.

## Gate

Per the agent-host release authority, tagging or publishing npm, publishing the container as a release, and merging or deploying relaycast-cloud each require Khaliq's direct request from his own identity. A request relayed by another agent does not count.
