# Proactive Issue Resolver Webhook Consumer

## Context

The `proactive-issue-resolver` persona is a hosted Workforce agent that
reacts to newly opened GitHub issues on `My-Senior-Dev/app`, classifies
them against a committed trust policy, and (for the auto class) dispatches
a supervised `POST /api/v1/ricky/runs` to ship a PR unattended.

This document covers the cloud half of the wiring only: registering the
persona's ingress as a gated HTTP `WebhookConsumer` so the GitHub webhook
route (`POST /api/v1/webhooks/github`) fans out qualifying events to it.

The persona, its handler, and the trust policy live in MSD/app. See:

- MSD PR: <https://github.com/My-Senior-Dev/app/pull/310>
- Authoritative spec: `personas/proactive-issue-resolver/specs/unattended-cloud-pipeline.md`
  (in the `My-Senior-Dev/app` repo)

Without this cloud-side consumer the persona deploys but never receives
webhooks, and the pipeline is non-functional.

## Env vars

Both are required to enable the consumer. The consumer is omitted from
`getConfiguredConsumers` when either is missing or empty, which makes
this change safe to merge and deploy ahead of operator setup.

| Env var | Required | Purpose |
| --- | --- | --- |
| `PROACTIVE_ISSUE_RESOLVER_URL` | to enable | HTTPS ingress URL of the deployed persona (returned by `agentworkforce hosted-agent deploy`). |
| `PROACTIVE_ISSUE_RESOLVER_TOKEN` | to enable | Bearer token for the ingress. Sent as `Authorization: Bearer <token>`. |

## Predicate

The consumer is scoped by an in-process predicate. It returns `true` only
when both conditions hold:

- `event.eventType === "issues.opened"`
- `event.payload.repository.full_name === "My-Senior-Dev/app"`

All other events on `provider: "github"` (other actions, other repos) are
recorded as skipped by the fanout registry and not delivered to the
persona's ingress. Adding a new watched repo is a one-line predicate edit
here; multi-repo support is intentionally out of scope for v1.

## Operator setup

One-time, performed once before the pipeline starts. Not part of the
runtime loop.

1. Install / re-scope the MSD GitHub App on `My-Senior-Dev/app` with
   `Issues: Read & Write`, `Pull requests: Write`, `Contents: Write` and
   the `Issues` event subscription. Webhook URL points at
   `${CLOUD_API_URL}/api/v1/webhooks/github` with secret stored as
   `GITHUB_WEBHOOK_SECRET` in cloud env.
2. Deploy the persona from MSD/app:
   `agentworkforce hosted-agent deploy personas/proactive-issue-resolver/persona.json`.
   Capture the ingress URL and bearer token from the deploy output. See
   the persona's README in MSD/app for the exact command and outputs.
3. Set cloud envs `PROACTIVE_ISSUE_RESOLVER_URL` and
   `PROACTIVE_ISSUE_RESOLVER_TOKEN` to the captured values, then redeploy
   cloud. The consumer appears in `getConfiguredConsumers(env)` and the
   webhook route begins dispatching.
4. Open a `docs`-labeled canary issue on `My-Senior-Dev/app` and confirm
   the persona claims it (`ricky-claimed` label appears within ~30s) and
   produces a PR.

## Rollback

Unset `PROACTIVE_ISSUE_RESOLVER_URL` and/or `PROACTIVE_ISSUE_RESOLVER_TOKEN`
in cloud env and redeploy. `getConfiguredConsumers` omits the consumer
from the returned list, the webhook route stops dispatching to the
persona, and the rest of cloud is unaffected.

No GitHub state mutation is required. In-flight Ricky runs continue to
completion under cloud supervision. Stale `ricky-claimed` labels can be
bulk-removed separately if desired.

## Files

| Path | Purpose |
| --- | --- |
| `packages/web/lib/integrations/webhook-consumers.config.ts` | Consumer registration and predicate. |
| `packages/web/lib/integrations/webhook-consumers.config.test.ts` | Regression tests for env-gating and predicate scoping. |
