# Release preparation for delivery confirmation (#625)

Status: released. **12.10.0** (minor) was published through the existing Publish NPM Packages workflow with `custom_version` on 2026-11-15; receipts are in "Publish receipts" below. The sections up to "Dispatch sequence" record the state at preparation time, before the `chore(release): v12.10.0` commit-back.

Source: relaycast#625 "delivery confirmation", merged to main as `b6cc6e1a57935ddfe36aac33f105ba8d185ee28c` (2026-11-14T22:37:04Z on GitHub; the commit timestamp in git is 22:37:03Z).

## Scope

Sender-facing delivery confirmation. The summary below is deliberately short; the detail lives in two places and is not duplicated here:

- `CHANGELOG.md`, section `## [12.10.0] - 2026-11-15` (was `## [Unreleased - Minor]` at preparation time)
- `docs/delivery-confirmation.md`

In short:

- One delivery state for senders: `queued | delivered | consumed | replied | failed`.
- `GET /v1/messages/:id/deliveries`, and the state on `POST /v1/dm` and `POST /v1/channels/:name/messages`.
- `wait_ms` (0-2000) on `POST /v1/dm` and channel posts, waiting for the recipient's acceptance.
- `reply_to_message_id` on DMs (and thread replies) marks exactly that delivery `replied`.
- Node frames `delivery.accepted` and `delivery.ack` (per-delivery `delivery_id` form); sender events `delivery.delivered` (with `accepted`), `delivery.acked`, `delivery.replied`.
- `node.register` replies list `capabilities`, so nodes send new frames by capability.
- TypeScript SDK: `agent.messageDeliveries(id)` and `relay.messages.deliveries(id)`, plus the `on.deliveryDelivered` hook (see `packages/sdk-typescript/CHANGELOG.md`).

The 12.10.0 section also carries the other entries merged since 12.8.0 (strict spawn, PostgreSQL self-host, A2A cards, and others); they shipped in the same release.

## Repository version state (at preparation time)

Every `package.json` (root workspace packages, `packages/*`), `ARG RELAYCAST_ENGINE_VERSION` in the `Dockerfile`, and the `@relaycast/engine` pin and version in `docker/package.json` were **12.8.0** on main before the commit-back, and the latest git tag was `v12.8.0`. `CHANGELOG.md` already contains `## [12.8.0] - 2026-11-04` with the pending entries above it.

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

The simplest path was 12.10.0 via `custom_version`, as above, and that is what was dispatched. The alternative was to first reconcile main to 12.9.0 (a `chore(release)` commit recording the already-published 12.9.0) and then publish 12.10.0 from there. Reconciling main with the published 12.9.0 remains open and is Khaliq's decision.

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

- npm `dist.integrity` and `dist.shasum` for `@relaycast/engine`, `@relaycast/types`, `@relaycast/a2a` and `@relaycast/sdk` at 12.10.0 (`npm view <pkg>@12.10.0 dist.integrity dist.shasum`)
- the workflow run URLs
- the GitHub release URL
- the image digest and its attestation (`gh attestation verify`)

> **Status 2026-11-15:** Publish NPM Packages was dispatched with exactly the proposed inputs (`custom_version` 12.10.0, `tag` latest, `dry_run` false) from main `b6cc6e1a` by `khaliqgant` via the codex-relay-control-session: run 43669541261. Receipts are recorded in "Publish receipts" below.

## Live self-host evidence

A test image was built from main `b6cc6e1a` by Publish Container run https://github.com/AgentWorkforce/relaycast/actions/runs/43668851096 with tag `12.8.0-dc625.1` and `latest=false` (engine skeleton from the npm 12.8.0 pin, with `dist` from main overlaid). It was exercised on live-cast (k3s, chart 0.3.3, SQLite) and then rolled back to the pinned 12.7.0 image; the capture is in "Live-cast evidence" below.

## Live-cast evidence

Captured 2026-11-15 on https://live-cast.agentrelay.com (Helm chart relaycast 0.3.3, SQLite, namespace `live-cast`). Secrets redacted; ids are real. Full captures and the reusable script live on the agent host under `/tmp/rel625/evidence/` (`evidence.mjs`, `old-12.7.0.json`, `new-dc625.json`).

- Test image: `ghcr.io/agentworkforce/relaycast-self-host@sha256:44f7edfd41928ab7fbb4caaf98a036ff45c4fdfc783bebbb6a7455d944cb4590` (tag `12.8.0-dc625.1`, Publish Container run 43668851096 from main `b6cc6e1a`, attestation id 67691123), deployed as Helm revision 4 with `--reuse-values --set image.digest=...`.
- Migrations applied on first boot of the test image, read from `_engine_migrations` in `/data/relaycast.db`: `0081_delivery_confirmation.sql`, `0082_pending_events_settled_retention.sql`, `0083_strict_spawn_placement_token.sql`, `0084_strict_spawn_dispatch_generation.sql` (all `applied_at` 1794711551). `deliveries` gained `accepted_at`, `replied_at`, `reply_message_id`; `messages` gained `reply_to_message_id`. The 0081-after-0082 ordering is expected: the SQLite migrator is set-based.
- Old engine 12.7.0 (pinned digest `sha256:81274dca7ab58673383dc7a9c777f422f29606c7422e81b5ea15724770f1455e`, workspace 247553604966010880): `GET /v1/messages/:id/deliveries` returns 404 `{"code":"not_found","message":"Route not found"}` for sender, non-sender, workspace key and unknown id; `POST /v1/dm` ignores `wait_ms` and returns no `delivery` object; `node.register` reply `capabilities` is `[]`; the sender's socket receives no `delivery.*` events.
- New engine (#625 test image, workspace 247556086941388800):
  - `POST /v1/dm` with `wait_ms: 2000` returned 201 in 113 ms with `delivery: {id, status: "delivered", state: "delivered", accepted_at, replied_at: null, reply_message_id: null, error: null, expires_at}` and `message.reply_to_message_id: null`.
  - `GET /v1/messages/:id/deliveries` as the sender: 200 `{message_id, deliveries: [{id, agent_id, agent_name, status, state, created_at, delivered_at, accepted_at, acked_at, replied_at, reply_message_id, dead_lettered_at, error, read_at}]}`. As a non-sender agent token: 404 `{"code":"message_not_found","message":"Message not found"}`. With the workspace key: 200. Unknown message id: 404 `message_not_found`.
  - After the recipient acked (`POST /v1/deliveries/:id/ack`) and replied (`POST /v1/dm` with `reply_to_message_id`), the sender view showed `status: "acked"`, `state: "replied"`, `reply_message_id` and `read_at` set.
  - `node.register` reply `capabilities`: `["delivery.accepted", "delivery.ack.delivery_id"]`; the server accepted the recipient's `{"v":1,"type":"delivery.accepted","agent":"bob","delivery_id":"..."}` frame.
  - Sender socket received `context.update` (`topic: "agent"`) events `delivery.delivered` with `accepted: false`, then `delivery.delivered` with `accepted: true`, then `delivery.acked`, then `delivery.replied` carrying `reply_message_id`. The recipient's own socket still receives the legacy minimal `delivery.delivered {delivery_id, message_id}`.
- Rollback: Helm revision 5 restored the pinned 12.7.0 digest; `/health` returned `{"ok":true}` and the pod image matched `sha256:81274dca...`. Both throwaway workspaces were deleted. The applied 0081–0084 rows remain in the live SQLite database and 12.7.0 runs fine beside them.

## Publish receipts (12.10.0)

Publish NPM Packages run [43669541261](https://github.com/AgentWorkforce/relaycast/actions/runs/43669541261) (workflow_dispatch on `main` `b6cc6e1a`, actor `khaliqgant`, inputs `package=all version=minor custom_version=12.10.0 dry_run=false tag=latest`). All publish jobs green; "Create Release" completed 2026-11-15T03:18Z.

| Package | Version | `dist.shasum` | `dist.integrity` |
| --- | --- | --- | --- |
| `@relaycast/engine` | 12.10.0 | `f50ab9ca8d7a86ef4842fd29ea7f8e0c463ff3ed` | `sha512-DwZVYXsPbpbQfPnnRThky7RvKITq0JnRbV2lmPquaiSR4XKkxrNKRrvsi/nk4VAsw5gREK1mJOifX7q9+kTveg==` |
| `@relaycast/types` | 12.10.0 | `f7ec7e9f92e245aff07bd34350a32e4fbc9c1c3d` | `sha512-onXSI+sqSuqHHF5uUPeR/WFvGpa4hvWQZHmCjjbZrUMjme3Ajo25MrDqRXkJo06g09/ib6pBbrZ7t+2Yvri4cQ==` |
| `@relaycast/a2a` | 12.10.0 | `d93f1c2fb16128243f30d120f2bd85a6c1264774` | `sha512-+zuvzmoEZ/i8fw2wGef+byTecEz1W/uIA2cawIpxeXRY+KD3ylIRpyLhZJBKZSAGFsbouQy0biPFQ3vgqPkSow==` |
| `@relaycast/sdk` | 12.10.0 | `f772660a357b5ec62319a3cede150847919f2f08` | `sha512-4IkDmOcZw/z4z/KR9Tw+tUlP9B0yWQ064ukE0iePxOzJiqGeHlxSQUnQkmSOX/rs3emRWTAB7JGkj5Y4zRIoZw==` |

`dist-tags.latest` is 12.10.0 for all four (checked with `npm view` on 2026-11-15, independently confirmed by codex-relay-control-session).

- Commit-back: `fd10195436054d97c75504d1c803df0d1f2fed98` `chore(release): v12.10.0` on `main` (parent `b6cc6e1a`, author GitHub Actions). It bumps every `package.json` (root workspace packages, `packages/*`, including `packages/a2a`), `ARG RELAYCAST_ENGINE_VERSION` in the `Dockerfile`, `packages/cli/src/version.ts`, `packages/sdk-typescript/src/version.ts`, and `docker/package.json` with its `@relaycast/engine` pin to 12.10.0, and moves the changelog entries under `## [12.10.0] - 2026-11-15`.
- GitHub release: https://github.com/AgentWorkforce/relaycast/releases/tag/v12.10.0 (published 2026-11-15T03:18:02Z by github-actions).
- Container: Publish Container run [43671881371](https://github.com/AgentWorkforce/relaycast/actions/runs/43671881371), workflow_dispatch from main `fd10195436054d97c75504d1c803df0d1f2fed98` with `tag=12.10.0`, `latest=true`, dispatched by the codex-relay-control-session. Job "Build and push" concluded `success` (created 2026-11-15T03:20:04Z, completed 2026-11-15T03:32:50Z).
  - Image: `ghcr.io/agentworkforce/relaycast-self-host@sha256:ec062ef901af15cf575b53a71d7eb09f2e6ab6e7c0d5be2da35339a275a5c6cc`. The GHCR package version for that digest was created 2026-11-15T03:31:57Z and carries tags `12.10.0` and `latest`.
  - Attestation: `gh attestation verify oci://ghcr.io/agentworkforce/relaycast-self-host@sha256:ec062ef901af15cf575b53a71d7eb09f2e6ab6e7c0d5be2da35339a275a5c6cc -R AgentWorkforce/relaycast` passes. The SLSA v1 provenance statement names subject digest `ec062ef9...a5c6cc`, source `git+https://github.com/AgentWorkforce/relaycast@refs/heads/main` at gitCommit `fd10195436054d97c75504d1c803df0d1f2fed98`, builder `.github/workflows/publish-container.yml@refs/heads/main`, invocation `actions/runs/43671881371/attempts/1`, signed by the Public Good Sigstore instance.
  - Self-host pin: the chart default and the live-cast release still point at the pinned 12.7.0 digest; moving the chart or live-cast to 12.10.0 is a separate step and is not done by this release.
  - Live proof on the published image (2026-11-15): live-cast (k3s, chart 0.3.3, SQLite) was pointed at `sha256:ec062ef901af15cf575b53a71d7eb09f2e6ab6e7c0d5be2da35339a275a5c6cc` with `helm upgrade --reuse-values --set image.digest=...` as Helm revision 6 (03:38:02Z); the pod reported engine package version 12.10.0 and `/health` returned `{"ok":true}`. The same redacted evidence capture used for the test image was rerun over HTTPS in a fresh throwaway workspace: all 21 steps and both sockets' frame sequences are identical to the test-image capture after scrubbing ids and timestamps. Specifically: `node.register` reply `capabilities` is `["delivery.accepted","delivery.ack.delivery_id"]`; `POST /v1/dm` with `wait_ms` returns the `delivery` object; `GET /v1/messages/:id/deliveries` returns 200 for the sender and the workspace key, 404 `message_not_found` for the non-sender and for an unknown id; after the recipient's `delivery.accepted`, REST ack and reply, the sender's row shows `accepted_at`, `acked_at`, `read_at`, `replied_at`, `reply_message_id`, `state: "replied"`, `status: "acked"`; the sender's socket received `delivery.delivered`, `delivery.acked` and `delivery.replied` context updates. `_engine_migrations` still ends at 0084 with no new rows (0081–0084 were applied by the earlier test image). Rolled back to the pinned 12.7.0 digest as Helm revision 7 (03:39:11Z), `/health` ok, pod image `sha256:81274dca...`; the throwaway workspace was deleted. layered-control was told before and after.
- Hosted proof (2026-11-15): relaycast-cloud PR #342 (pins engine 12.10.0, migrations 0081/0083/0084) merged at 18025116 and the normal Deploy run 43674383244 succeeded at 03:56:51Z; `GET https://api.relaycast.dev/health` reports build `18025116ab673afcb74ebb4e13f9ecc7211fbe6a`. The same 21-step capture used on live-cast then passed on production in a disposable workspace created through the public `POST /v1/workspaces` route and deleted afterwards (`DELETE /v1/workspaces/:id` 204, key then 401): `node.register` listed both capabilities, `POST /v1/dm` with `wait_ms=2000` returned the `delivery` object, the sender received `delivery.delivered` (accepted false then true), `delivery.acked` and `delivery.replied`, and `GET /v1/messages/:id/deliveries` went delivered -> replied with `accepted_at`, `acked_at`, `replied_at` and `reply_message_id` set; the non-sender agent and an unknown id got 404 `message_not_found`, the workspace key 200. HTTP statuses and the sender event sequence were identical to the live-cast capture. Hosted `wait_ms` held the request about 2.8 s but still returned the initial `queued` state (waiter follow-up still pending).
- Hosted proof, steps 6-7 (2026-11-15 04:40Z, build `18025116`): a second 57-step capture ran on production in two fresh disposable workspaces (public `POST /v1/workspaces`, both deleted afterwards with 204 then 401). Write-side wrong-resource controls: a third agent's `POST /v1/deliveries/:id/ack` on another agent's delivery and an ack of a fabricated id both returned 404; `delivery.accepted` / `delivery.ack` frames naming another agent's `delivery_id`, or a fabricated one, produced no reply and left the sender's row identical (`accepted_at` null) until the real recipient accepted and acked; `reply_to_message_id` naming a message the replier never received, a fabricated id, or a message from another workspace all returned 400 `invalid_request`; another workspace's key and agent token got 404 on `GET /v1/messages/:id/deliveries`. Registered-action round trip: `POST /v1/actions` 201, `POST /v1/actions/:name/invoke` 201 with the handler's `action.invoke` frame, `complete` 200, `GET .../invocations/:id` 200, same-key replay 201. Strict spawn: a node enrolled via `POST /v1/nodes` with `spawn:<cli>` capacity accepted the capability on `node.register`, `POST /v1/actions/spawn/strict-invoke` returned 201, the node received `action.invoke` and declined it with `action.result`, `GET /v1/actions/spawn/invocations/:id` showed the invocation `failed` with that error, the same-key replay returned 201 and a missing `Idempotency-Key` 400. The hosted `wait_ms` waiter is on relaycast-cloud branch `agent/hosted-delivery-state-waiter` (baae8286).

## Gate

Per the agent-host release authority, tagging or publishing npm, publishing the container as a release, and merging or deploying relaycast-cloud each require Khaliq's direct request from his own identity. A request relayed by another agent does not count.
