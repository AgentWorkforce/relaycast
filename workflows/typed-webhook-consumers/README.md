# typed-webhook-consumers

Replaces the brittle `WEBHOOK_CONSUMERS_JSON` SST secret with typed code
+ per-consumer SST secrets. Runs against a **dedicated cloud worktree**
at `/Users/khaliqgant/Projects/AgentWorkforce/cloud-typed-webhook-consumers`
on branch `feat/typed-webhook-consumers` so it never touches your cloud
main checkout.

## Why

The JSON blob replaces the default consumers entirely when set, which is
how `sage` silently got dropped from the Slack fanout list in prod. The
typed path declares `sage` in code, so it is always registered.

## Run

```
cd /Users/khaliqgant/Projects/AgentWorkforce/cloud-typed-webhook-consumers
agent-relay run workflows/typed-webhook-consumers/00-execute.ts
```

Do not run this from `cloud/` (main) — the workflow's preflight will
reject any cwd that isn't the worktree, so you do not accidentally
commit to main.

## What it does

| Sub | Touches | Purpose |
|---|---|---|
| 01 | `packages/web/lib/integrations/webhook-consumers.config.ts` (new) | Typed `getConfiguredConsumers(env)` — sage + relayfile-primary always, msd-backend opt-in via env |
| 02 | `packages/web/lib/integrations/webhook-consumer-registry.ts` | `bootstrapRegistryFromEnv` delegates to the typed module; JSON path kept as deprecated fallback with warn log |
| 03 | `infra/secrets.ts` + `infra/web.ts` | New `WebhookMsdBackendUrl` / `WebhookMsdBackendToken` SST secrets + env wiring |
| 04 | full repo | Integrated review (Claude + Codex) + `npm test` + `tsc` + push + `gh pr create` (graceful skip if gh unavailable) |

## Rollout after merge

1. `sst secret set WebhookMsdBackendUrl <url> --stage production`
2. `sst secret set WebhookMsdBackendToken <token> --stage production`
3. `sst deploy --stage production`
4. Watch CloudWatch `webhook-fanout` logs — should show both `sage` and
   `msd-backend` succeeding.
5. Follow-up PR: delete `WebhookConsumersJson` secret + JSON-parse
   branch.

## Cleanup

When done:

```
cd /Users/khaliqgant/Projects/AgentWorkforce/cloud
git worktree remove ../cloud-typed-webhook-consumers
git branch -D feat/typed-webhook-consumers   # if you want to reclaim
```
