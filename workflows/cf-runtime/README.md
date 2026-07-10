# cf-runtime: long-running agent turns on Cloudflare Workers

Fix: `waitUntil cancelled` kills long Sage turns (Slack silence on Notion/etc.
lookups). Build a reusable CF-adapter layer in `agent-assistant` so both Sage
and Specialist (and future Nightcto/My-Senior-Dev personas) can run turns
against the existing `@agent-assistant/continuation` runtime without being
bound by request-lifecycle deadlines.

See [SPEC.md](./SPEC.md) for the architecture contract. Workflows below
implement it in dependency order.

## Dependency graph

```
┌───────── sage repo ─────────┐   ┌────────── agent-assistant repo ──────────┐
│                             │   │                                          │
│  W0 sage-factor-turn-exports│   │  W1 runtime-core  ─┐                     │
│                             │   │                    ├─► W2 continuation-  │
│                             │   │                    │   adapters ─┐       │
│                             │   │  W4 webhook-        │              │      │
│                             │   │     hardening ──────┤              │      │
│                             │   │                                    ▼      │
│                             │   │                             W3 executor   │
└──────────────┬──────────────┘   └────────────────────────────────────┼──────┘
               │                                                       │
               └────────────┬──────────────────────────────────────────┘
                            │
                ┌─── HUMAN GATE 1 ───┐
                │ merge W0 + W1–W4   │
                │ npm publish:       │
                │   @agentworkforce/sage (1.5.0)                │
                │   @agent-assistant/cloudflare-runtime (0.1.0) │
                │   @agent-assistant/webhook-runtime (patch if W4 shipped one) │
                │ bump versions in cloud workspace │
                ▼
┌──────────────────── cloud repo ──────────────────────────┐
│                                                          │
│  W5 agent-persona-factory ──┬── W6 sage-migration        │
│                             │                            │
│                             └── W7 specialist-migration  │
│                                                          │
└──────────────────────────────────────────────────────────┘
                   │
                   └─── HUMAN GATE 2 ──► merge cloud PRs → CI deploy
```

## Run order and parallelism

Workflows are numbered by **start order**, not strict sequence — any that share
the same upstream dependency run in the same wave.

### Wave A (parallel across two repos)

W0 runs in `../sage`; W1 and W4 run in `../agent-assistant`. All three touch
disjoint codebases and can run fully in parallel:

```bash
cd /Users/khaliqgant/Projects/AgentWorkforce/cloud
agent-relay run workflows/cf-runtime/00-sage-factor-turn-exports.ts &
agent-relay run workflows/cf-runtime/01-runtime-core.ts &
agent-relay run workflows/cf-runtime/04-webhook-runtime-hardening.ts &
wait
```

### Wave B (agent-assistant repo, after W1)

```bash
agent-relay run workflows/cf-runtime/02-runtime-continuation-adapters.ts
```

### Wave C (agent-assistant repo, after W2 and W4)

```bash
agent-relay run workflows/cf-runtime/03-runtime-executor.ts
```

### ⏸ HUMAN GATE 1

At this point you have **5 open PRs** — 1 in `sage`, 4 in `agent-assistant`.
You:

1. Review and merge each in dependency order:
   - In `agent-assistant`: W1 → W4 → W2 → W3.
   - In `sage`: W0 (independent of the agent-assistant PRs but depends on
     `@agent-assistant/surfaces` already exposing `SlackEventDedupGate` —
     which it does today, so W0 can merge anytime).
2. From each repo root, run `npm run build` and `npm test` to sanity-check.
3. Publish new versions:

   ```bash
   # Sage
   cd ../sage
   npm version minor            # 1.4.20 → 1.5.0 (new exports, backward compat)
   npm publish

   # Agent-assistant
   cd ../agent-assistant
   npm version patch --workspace=packages/webhook-runtime  # only if W4 changed it
   npm version minor --workspace=packages/cloudflare-runtime
   npm publish --workspace=packages/cloudflare-runtime
   npm publish --workspace=packages/webhook-runtime
   ```

4. Bump those versions in `cloud/package.json` /
   `cloud/packages/sage-worker/package.json` /
   `cloud/packages/specialist-worker/package.json` before starting Wave D.

### Wave D (cloud repo, after gate 1)

```bash
agent-relay run workflows/cf-runtime/05-cloud-agent-persona-factory.ts
```

### Wave E (cloud repo, after W5 merges; parallel)

These touch different workers:

```bash
agent-relay run workflows/cf-runtime/06-sage-migration.ts &
agent-relay run workflows/cf-runtime/07-specialist-migration.ts &
wait
```

### ⏸ HUMAN GATE 2

1. Review and merge W6 and W7 cloud PRs.
2. CI deploys sage and specialist to `sage` stage.
3. Smoke test:

   ```bash
   # Confirm the waitUntil warning is gone under load
   wrangler tail sage --format json --status error | head
   # Confirm long-cook Slack messages now get replies
   ```

4. If stable on sage stage for 24h, promote to prod via the normal deploy flow
   (per memory: never deploy to prod manually — must go through CI).

## Team shape per workflow

Every workflow uses the same role layout (see each file for details):

| Role             | CLI      | Preset         | Responsibility                       |
| ---------------- | -------- | -------------- | ------------------------------------ |
| `lead`           | claude   | (interactive)  | Architecture reviewer, rejects shortcuts |
| `impl-*`         | codex    | (interactive)  | Writes code, listens on channel      |
| `reviewer`       | claude   | `reviewer`     | Reads diff + writes KEEP/PAUSE verdict |
| `tester`         | claude   | `worker`       | Writes tests, fixes failures         |

Implementers are Codex; lead + reviewer + tester are Claude per user request.

## Validation gates (80-to-100)

Every workflow MUST pass these deterministic gates before opening its PR:

1. `git diff --quiet <file>` check after every agent edit
2. `npx tsc --noEmit` on the package
3. Test run (vitest / node:test) — `failOnError: true` on the final run
4. Package exports check — `node -e "import('<pkg>').then(console.log)"`
5. Lint (if configured) — non-fatal but reported in the PR description
6. For continuation/executor code: a **replay harness test** that runs a real
   harness turn to completion under a synthetic `ExecutionContext` whose
   `waitUntil` is the collecting shim. This is the direct regression test
   for the Slack-silence bug.

## Branch / PR conventions

- Every workflow uses **worktrees** (per `feedback_always_worktree_for_prs`
  memory) — created by `lib/worktree-setup.ts`. Worktree path:
  `../.worktrees/<repo>/<branch>`
- Branch names:
  - W0 `feat/factor-turn-exports` (sage repo)
  - W1 `feat/cf-runtime-core`
  - W2 `feat/cf-runtime-continuation-adapters`
  - W3 `feat/cf-runtime-executor`
  - W4 `chore/webhook-runtime-multipersona`
  - W5 `feat/cloud-agent-persona-factory`
  - W6 `feat/sage-on-cf-runtime`
  - W7 `feat/specialist-on-cf-runtime`
- PR titles follow conventional commits; bodies must include:
  1. Link back to this README
  2. Regression test result evidence (verbatim output from the replay harness)
  3. Rollback plan (revert SHA + SST deploy)

## Rollback

- Wave D–E (cloud): revert the merge commit; previous SST version of sage /
  specialist is re-deployed by CI. Queue messages drain cleanly; KV continuation
  records TTL out.
- Wave A–C (agent-assistant): un-publish not possible. Bump to previous working
  version of `@agent-assistant/cloudflare-runtime` in cloud workspace and
  redeploy.

## Resuming a failed workflow

Per `writing-agent-relay-workflows` rule §7a:

- Transient failure, no edits: `agent-relay run --resume <id>`
- You edited the workflow file to fix a step: `agent-relay run --start-from
  <failing-step> --previous-run-id <id>`

Each workflow's preflight is designed to tolerate the dirty-file state a prior
partial run would leave behind — see `lib/worktree-setup.ts`.
