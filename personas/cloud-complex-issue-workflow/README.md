# cloud-complex-issue-workflow

A **distinct, multi-agent** proactive path for GitHub issues — separate from the
single-agent `cloud-small-issue-codex` persona. Reacts to **issues on
`AgentWorkforce/cloud` labeled `complex`**, runs a four-stage workflow
(plan → implement → review → open-PR, plus one bounded repair pass), and opens a
PR whose body carries the plan summary and the review verdict.

## How it differs from `cloud-small-issue-codex`

| | `cloud-small-issue-codex` | `cloud-complex-issue-workflow` |
| --- | --- | --- |
| Label | `small` | `complex` |
| Workflow | single `impl` (codex) step | `planner` (claude) → `impl` (codex) → `reviewer` (claude) → bounded repair |
| PR body | base text | base text + **plan** + **review verdict** |
| Stage artifacts | `implement` | `plan`, `implement`, `review`, `implement-repair-*` |

The integration-watch dispatcher is **label-agnostic** — it matches both personas
on the same issue paths/events and fans out a delivery to each. Each persona
self-selects by label inside its handler and claims via its own dispatch-claim
root, so the two never collide. The `small` persona carries a one-line precedence
guard (skip when `complex` is present) to avoid a double-PR on a dual-labeled
issue.

## Flow

1. Webhook → cloud → integration-watch dispatcher matches the GitHub trigger
   paths declared in the top-level `agent.ts` agent block and enqueues a
   delivery for this agent.
2. The handler receives the `github.issues.opened` (or `…labeled`) envelope,
   checks the `complex` label, and bails otherwise.
3. Posts to Slack `#proj-cloud` and claims the issue with a GitHub comment.
4. Materializes `workflows/cloud-complex-issue-workflow.ts` in the sandbox and
   invokes it with `ctx.workflow.run()`:
   - **preflight** — materialize the repo working tree (reused clone plumbing).
   - **plan** (claude) — write `PLAN.md` (files to change, approach, validation).
   - **implement** (codex) — implement the plan across the working tree.
   - **review** (claude) — write `REVIEW.md` whose first line is
     `VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`.
   - **implement-repair** (codex, bounded single pass) — apply review fixes when
     changes are requested; no-op on approve.
   - **open-pr** — collect the working-tree diff (excluding `PLAN.md`/`REVIEW.md`)
     and open a PR through the Cloud proxy, embedding the plan + review verdict in
     the PR body.
5. Posts the PR link back to Slack + the issue, and persists thread state for
   follow-up Q&A.

## v1 scope / v2 upgrades

- **v1 runs the stages sequentially in one sandbox** (cheaper, closer to the
  proven small-issue path) but as four **distinct** stages, each producing its own
  artifact under `.agent-relay/step-artifacts/`. Separate-sandbox-per-stage
  isolation is a v2 upgrade.
- The Cloud PR proxy accepts a `files[]` payload and therefore produces a
  **single commit**. Plan + review live in the PR body and as stage artifacts.
  True multi-commit history is a v2 upgrade (git-push PR path).
- A real review↔fix loop (Claude+Codex until dual signoff) is a v2 upgrade; v1
  ships one bounded repair pass to keep the DAG acyclic.

## Deploy

```bash
agentworkforce deploy ./personas/cloud-complex-issue-workflow --mode cloud
```

> **Deploy gating:** registering this persona upserts a `watch_rules` row into the
> `agents` table from the declarative `agent.ts` trigger block. During the live
> Aurora/Neon DB cutover (P0), the deploy step is held; the persona code merges
> first (pure code + tests) and the actual deploy follows once the DB situation
> is resolved.

`systemPrompt` is a minimal compatibility shim for cloud deploy validation;
runtime behavior and deploy triggers are driven by `agent.ts`.

## Sandbox requirements

Same as `cloud-small-issue-codex`:

- `WORKFORCE_WORKSPACE_TOKEN` with `workflow:invoke:write` and `workflow:runs:read`.
- `WORKFORCE_CLOUD_BASE_URL` / `CLOUD_API_URL` + `CLOUD_API_ACCESS_TOKEN`.
- Relayfile mount env for GitHub and Slack writebacks.
- Harness credentials for Slack-thread Q&A through `ctx.harness.run()`.
