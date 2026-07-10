# Ricky Slack Nango-Routed Migration Spec

**Status:** draft, depends on PR #480 (`feat/ricky-linear-agent-surface`) merging to main, since it establishes the same Nango-routed pattern for Linear and the shared `webhook-dedup.ts`.
**Owner:** Cloud + Ricky.
**Last updated:** 2026-05-07.
**Primary repos:** `../cloud` (this repo).
**Reference manifest:** `integrations/slack/ricky-manifest.json` (current direct config) and `integrations/linear/ricky-manifest.json` (post-#480 Nango pattern, the model for this migration).

## 1. Problem Statement

The Ricky Slack agent v2 surface (PR #412, merged) was built before the rest of the cloud's webhook intake consolidated onto Nango. Today its dedicated Slack app POSTs directly to three Cloud routes:

- `app/api/v1/ricky/slack/events/route.ts` — `app_mention`, `message.im` (async)
- `app/api/v1/ricky/slack/commands/route.ts` — `/ricky` slash command (synchronous response expected within 3s)
- `app/api/v1/ricky/slack/interactivity/route.ts` — gate-approval block_actions and view_submission (synchronous response expected within 3s)

Each route calls `readVerifiedSlackBody` from `lib/ricky/slack/signature.ts`, which verifies a Slack HMAC against `Resource.RickySlackSigningSecret.value` / `Resource.SlackSigningSecret.value` (with env-var fallbacks `RICKY_SLACK_SIGNING_SECRET`, `SLACK_SIGNING_SECRET`).

Sage's Slack integration uses the opposite pattern: Slack → Nango → `/api/v1/webhooks/nango` → `routeNangoWebhook` → `routeForwardEvent` → `forwardToSage`. Nango's signature is verified once at the Cloud entry; no Slack-app-specific secret in the cloud repo. PR #480 just established the same pattern for Linear AgentSession events (`handleLinearForward` detects `AgentSessionEvent` payloads and dispatches into `dispatchLinearSessionEvent`).

This spec migrates the Ricky Slack surface to that pattern so the Slack signing secret, `lib/ricky/slack/signature.ts`, and the dedicated routes can all be removed.

## 2. Goals

- Point the Ricky Slack app's `events`, `commands`, and `interactivity` request URLs at Nango using the same URL pattern Sage already uses (`integrations/slack/manifest.json`): `https://api.nango.dev/webhook/REPLACE_WITH_NANGO_ENVIRONMENT_UUID/slack-ricky`. Operators substitute the Nango environment UUID at manifest-upload time.
- Add a Slack-Ricky branch in `packages/web/lib/integrations/nango-webhook-router.ts` that detects events vs slash command vs interactivity payloads and dispatches into existing handlers in `packages/web/lib/ricky/slack/`.
- Refactor command + interactivity dispatch to use Slack's deferred response pattern (`response_url` for slash commands and most interactivity; `chat.update` for gate-approval message edits) since Nango forwards webhooks fire-and-forget — Slack only sees Nango's 200, not Cloud's body.
- Delete `packages/web/app/api/v1/ricky/slack/events/route.ts`, `commands/route.ts`, `interactivity/route.ts`, and `lib/ricky/slack/signature.ts`.
- Update `integrations/slack/ricky-manifest.json` to reflect Nango-routed delivery (mirror the post-#480 `integrations/linear/ricky-manifest.json` shape; use the Nango webhook URL pattern in goal 1 above).
- Preserve the `oauth/route.ts` flow for OAuth installation — that's not a webhook and stays as-is.

## 3. Non-Goals

- Sage's Slack integration is unchanged. This spec only touches the Ricky Slack app.
- The Ricky Slack and Sage Slack apps remain separate. Consolidation into a single shared app is explicitly out of scope.
- The slash command surface (`/ricky run ...`) keeps the same UX and supported subcommands. Only the transport changes.
- The gate-approval interactivity behavior keeps the same UX. Only the transport changes.
- View submissions in the current surface only do `response_action: "clear"` (modal close); this spec accepts that the Nango-routed flow can't return that synchronously and the modal will close on Slack's 3s client-side timeout. If a future surface needs `response_action: "errors"` (field-level validation), that interaction must remain direct (out of scope).
- URL verification: Nango is assumed to auto-respond to Slack's `url_verification` challenge for forwarded events URLs (same path Sage's Slack manifest uses today via `integrations/slack/manifest.json`). Cutover is a single Slack-app dashboard URL swap. If a future Nango configuration regression breaks this, treat it as an ops issue, not a spec change.
- No changes to Slack OAuth install flow (`app/api/v1/ricky/slack/oauth/route.ts`).
- No changes to the underlying `lib/ricky/slack/ingress.ts`, `egress.ts`, `auth.ts`, `store.ts`, `parser.ts`, `proactive.ts` business logic — only the entry/exit shape changes (input becomes a Nango envelope; output becomes deferred `response_url` POSTs / `chat.update` calls instead of synchronous `Response`).

## 4. Constraints From Slack's Webhook Semantics

| Endpoint | Slack expectation | Today | Post-migration |
|---|---|---|---|
| `events` | 200 within 3s; body ignored except `url_verification` challenge response | `app/api/v1/ricky/slack/events/route.ts` returns `{ok:true}` synchronously after kicking off `handleRickySlackCommand` | Nango router branch dispatches `handleRickySlackCommand` async; events have no `response_url` so user-facing replies use `chat.postMessage` via egress (already supported). |
| `commands` | 200 within 3s; body becomes the slash command's response | Returns `Response` synchronously from `handleRickySlackCommand` | Nango router branch dispatches the command async; first `response_url` POST is "Got it, working on it" within ~1s; subsequent updates either via additional `response_url` POSTs (within 30 min, up to 5x) or via `chat.postMessage`. |
| `interactivity` (block_actions on gate buttons) | 200 within 3s; body optional; `chat.update` on the original message is the standard way to reflect state | Returns sync; uses `updateGateSlackMessage` and resumes the run | Nango router branch dispatches async; `chat.update` already happens via `updateGateSlackMessage`. The earlier sync response only confirmed receipt; that's now implicit in Nango's 200. |
| `interactivity` (view_submission with `response_action: "clear"`) | Sync response within 3s; no response = client timeout | Returns `{response_action: "clear"}` sync | Modal closes on client timeout (~3s). Acceptable per non-goals; document as known UX trade-off. |

URL verification: Slack POSTs `{type: "url_verification", challenge: "..."}` once when the events URL changes. With Nango as the receiver, Nango must echo the challenge. If Nango doesn't, manual one-shot verification is required (point URL at Cloud direct, take the challenge, point back to Nango).

## 5. File Changes

### 5.1 New / changed

- `packages/web/lib/integrations/nango-webhook-router.ts`:
  - Import `handleRickySlackCommand`, `dispatchRickySlackCommand`, and the new interactivity dispatcher (see 5.4) from `lib/ricky/slack/ingress.ts`.
  - In `routeForwardEvent`, the Slack branch (line 787) currently sends *every* slack-prefixed provider to Sage. Add disambiguation: if `provider === "slack-ricky"` (or matched via the alias map; see 5.5), dispatch to `handleRickySlackForward(envelope)`. Otherwise keep current behavior (Sage).
  - New `handleRickySlackForward(envelope)`: detect payload shape (event vs command vs interactivity), claim dedup via `claimWebhookDelivery({ surface: "slack", deliveryId })`, route to the correct ingress handler.

- `packages/web/lib/ricky/slack/ingress.ts`:
  - Refactor `handleRickySlackCommand` from "returns `Response`" to "POSTs replies to `responseUrl` (if present) or via `chat.postEphemeral`/`chat.postMessage` (if not)" — return type becomes `Promise<void>` (or `Promise<{ status }>`).
  - Add `dispatchRickySlackInteractivity(payload)` that mirrors what `interactivity/route.ts` does today but uses `chat.update` + `response_url` POSTs instead of returning `NextResponse.json(...)`.
  - All existing helpers (`canResolveRickySlackGate`, `updateGateSlackMessage`, etc.) stay; only the wrappers that previously returned `Response` change.

- `packages/web/lib/ricky/slack/egress.ts`:
  - Add `postSlackResponseUrl({ responseUrl, body })` helper. Verified 2026-05-07 not present in `egress.ts`. Implementation: `await fetch(responseUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })`. Throw on non-2xx so callers can log + dedup-retry.

- `integrations/slack/ricky-manifest.json`:
  - Replace `request_url` for `event_subscriptions`, `slash_commands`, and `interactivity` with `https://api.nango.dev/webhook/REPLACE_WITH_NANGO_ENVIRONMENT_UUID/slack-ricky` (same template Sage's `integrations/slack/manifest.json` uses for its events URL).
  - Drop `signing_secret_env`-style assumptions in any documentation. Mirror the structure of `integrations/linear/ricky-manifest.json` (`webhook.delivery: "via Nango"`, `nango.provider_config_key: "slack-ricky"`, `webhook_router` pointer).

### 5.2 Deletions

- `packages/web/app/api/v1/ricky/slack/events/route.ts`
- `packages/web/app/api/v1/ricky/slack/commands/route.ts`
- `packages/web/app/api/v1/ricky/slack/interactivity/route.ts`
- `packages/web/lib/ricky/slack/signature.ts`
- Any `signature.test.ts` / `events.test.ts` / `commands.test.ts` / `interactivity.test.ts` that exercise the deleted modules. Replace with router-level dispatch tests (see 5.6).

### 5.3 Keep

- `packages/web/app/api/v1/ricky/slack/oauth/route.ts` — OAuth installation, not a webhook.
- `packages/web/lib/ricky/slack/dedup.ts` — already a thin wrapper around `webhook-dedup.ts` after #480.
- `packages/web/lib/ricky/slack/{auth,blocks,egress,ingress,parser,proactive,store}.ts` — business logic, only ingress entry shape changes (5.1).

### 5.4 Interactivity dispatcher contract

The current interactivity route handles two payload shapes:

1. `block_actions` on a gate-approval message (the bulk of the file). Migration: same logic, but instead of `return NextResponse.json({ ok: true })`, do nothing (Nango already returned 200 to Slack). The `chat.update` of the original message via `updateGateSlackMessage` already happens; that's the user-visible feedback.
2. `view_submission` returning `{response_action: "clear"}`. Migration: do nothing (Slack closes the modal client-side after timeout). Document the trade-off.

For error paths that today return non-2xx (`forbidden`, `not_found`, `gate_not_open`, etc.), surface the error to the user via `chat.postEphemeral` to the original channel (use payload.channel.id) instead of a 403 status. Slack already saw 200 from Nango.

### 5.5 Provider config key registry

`packages/web/lib/integrations/nango-webhook-router.ts` has a `PROVIDER_CONFIG_KEY_TO_PROVIDER` alias map (around line 108). Verified 2026-05-07: it currently lists `slack-relay`, `slack-sage`, `slack-my-senior-dev`, `slack-nightcto` — no `slack-ricky`. Add the line `"slack-ricky": "slack-ricky",` next to the other "separate products" entries. `packages/web/lib/integrations/providers.ts` already has a `slack-ricky` entry (defaultConfigKey `slack-ricky`, vfsRoot `/slack-ricky`); no change needed there.

`isSlackProvider` matches `slack-*` providers indiscriminately. The Slack branch needs explicit disambiguation:

```ts
if (provider === "slack-ricky" || envelope.providerConfigKey === "slack-ricky") {
  await handleRickySlackForward(envelope);
  return;
}
if (isSlackProvider(provider) || looksLikeSlackFrom(envelope.from)) {
  await repairSlackIntegrationFromForwardEvent(envelope, provider);
  await forwardToSage(envelope);
  return;
}
```

### 5.6 Tests

Replace the deleted route-level tests with router-dispatch tests in `packages/web/lib/integrations/__tests__/` (or similar):

- `slack-ricky-events-dispatch.test.ts` — feed a fake forward envelope shaped like a Slack event, assert `handleRickySlackCommand` is called with the expected fields, assert dedup short-circuits a second call.
- `slack-ricky-command-dispatch.test.ts` — feed a fake forward envelope for a slash command, assert `dispatchRickySlackCommand` calls `postSlackResponseUrl` with the expected ack, assert idempotency.
- `slack-ricky-interactivity-dispatch.test.ts` — feed a block_actions envelope, assert `updateGateSlackMessage` is called and no sync return shape exists.

PGlite-backed tests for the dedup shared with Linear already exist in `packages/web/lib/ricky/linear/__tests__/dedup.test.ts` (post-#480) — no need to duplicate.

## 6. SST / Secrets Cleanup

Verified 2026-05-07 via `grep -rn "RickySlackSigningSecret\|SlackSigningSecret\|RICKY_SLACK_SIGNING_SECRET\|SLACK_SIGNING_SECRET"` over `infra/`, `scripts/`, `.github/`, and `packages/`: the SST resources `RickySlackSigningSecret` and `SlackSigningSecret` are **not** declared in `infra/secrets.ts`, **not** present in any `link: [...]` array in `infra/web.ts` or other infra files, **not** in `scripts/set-secrets.sh`, **not** in `.github/workflows/_deploy-cloud-stage.yml`, and **not** in `packages/web/lib/boot/resource-check.ts::REQUIRED_RESOURCES`. The only references are the four reads inside `lib/ricky/slack/signature.ts` (`readLinkedSecret("RickySlackSigningSecret")`, `readLinkedSecret("SlackSigningSecret")`, `process.env.RICKY_SLACK_SIGNING_SECRET`, `process.env.SLACK_SIGNING_SECRET`), all guarded by try/catch fallbacks.

Therefore the cleanup is single-place: deleting `lib/ricky/slack/signature.ts` (per §5.2) removes every reference. No SST six-place reverse-walk needed. No CI/workflow secret seeding to remove.

After deploy, confirm:

```bash
grep -rn "RickySlackSigningSecret\|SlackSigningSecret\|RICKY_SLACK_SIGNING_SECRET\|SLACK_SIGNING_SECRET" packages/ infra/ scripts/ .github/
```

returns no matches.

(Note: `workflows/cf-runtime/01-runtime-core.ts` contains the literal string `SLACK_SIGNING_SECRET` inside a code-generation template that emits Cloudflare Worker source — that's unrelated to this repo's Slack signing secrets and stays.)

## 7. Rollout Plan

Sequence matters because the Slack app's webhook URLs are global (changing them invalidates direct routes immediately).

1. **Land code changes** (this PR). Routes still exist on `main` until merge, so the Slack app keeps using direct delivery during review.
2. **Pre-merge: register `slack-ricky` Nango integration**. Mirror Sage's `slack-relay` Nango configuration; the Nango integration id then substitutes into the manifest URL (§5.1). The file-sync routes already use this Nango forward pattern for Linear and Slack-Sage, so no Nango feature work is needed.
3. **Post-merge, pre-Slack-app-update**: deploy the change. The new Nango router branch is live but unused (Slack still POSTs direct to the now-404 routes; this is brief).
4. **Slack app dashboard switch**: in the Ricky Slack app's developer dashboard, change the events / slash commands / interactivity request URLs to `https://api.nango.dev/webhook/<slack-ricky-integration-id>/slack`. Single-step cutover (Nango auto-responds to Slack's `url_verification` challenge, same as Sage).
5. **Bake**: smoke-test slash commands, mentions, gate approvals in a sandbox workspace. Confirm the new deferred-response UX is acceptable (slash commands may take ~1s longer to show the first response than before).
6. **Document**: add a note to the runbook that any future Slack interactivity requiring `response_action: "errors"` (field-level modal validation) cannot use the Nango-routed pattern and must be reverted to a direct route with HMAC.

## 8. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Slash command UX regression (slower first response) | Send the deferred ack ("Got it, working on it") within ~500ms via `response_url`; existing callers already chain to subsequent updates. |
| view_submission timeout shows error to user | Current surface only does `response_action: "clear"`; documented trade-off. If a surface needs validation errors later, that interactivity stays direct. |
| `provider === "slack-ricky"` dispatch collides with Sage's slack-* matcher | Disambiguate explicitly (§5.5); add a unit test for the router branching. |
| Concurrent Slack and Linear deliveries collide on `ricky_webhook_dedup` keys | Composite primary key `(surface, delivery_id)` already handles this — covered by `dedup.test.ts`. |

## 9. Acceptance Criteria

- [ ] `app/api/v1/ricky/slack/{events,commands,interactivity}/route.ts` deleted; `oauth/route.ts` retained.
- [ ] `lib/ricky/slack/signature.ts` deleted.
- [ ] No source file references `RickySlackSigningSecret`, `SlackSigningSecret`, `RICKY_SLACK_SIGNING_SECRET`, or `SLACK_SIGNING_SECRET` (verify with `grep -rn`).
- [ ] `nango-webhook-router.ts` routes `slack-ricky` provider envelopes to the new dispatcher; default Slack-* still goes to Sage.
- [ ] `lib/ricky/slack/ingress.ts::handleRickySlackCommand` returns `Promise<void>` and uses `responseUrl` / `chat.postEphemeral` for replies.
- [ ] `integrations/slack/ricky-manifest.json` reflects Nango-routed delivery (mirrors `integrations/linear/ricky-manifest.json` shape).
- [ ] `npx tsc -p packages/web/tsconfig.json --noEmit` clean.
- [ ] `npx vitest run packages/web/lib/ricky packages/web/lib/integrations` clean (router-dispatch tests pass).
- [ ] `npm run web:drizzle-journal:test` clean.
- [ ] Bot reviewers (coderabbit, codex) addressed.

## 10. References

- PR #412 (`feat(ricky): add Slack agent v2 surface and routes`) — original direct-route implementation.
- PR #480 (`feat(ricky): add Linear agent webhook surface and shared webhook dedup`) — establishes the Nango-routed pattern this spec mirrors.
- `packages/web/app/api/v1/webhooks/nango/route.ts` — canonical Nango webhook intake.
- `packages/web/lib/integrations/nango-webhook-router.ts` — `routeNangoWebhook` / `routeForwardEvent` / Linear AgentSession dispatch (post-#480).
- `integrations/linear/ricky-manifest.json` (post-#480) — manifest shape model.
- CLAUDE.md "Adding a new SST resource" — six-place rule, applied in reverse for removal here.
