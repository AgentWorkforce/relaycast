# cloud-small-issue-codex

First "useful" proactive agent. Reacts to **issues opened on `AgentWorkforce/cloud`
with the `small` label**, starts the small-issue workflow, opens a PR, and
answers follow-up questions in the Slack thread from persisted thread state.

## Flow

1. Webhook → cloud → integration-watch dispatcher matches the GitHub trigger
   paths declared in the top-level `agent.ts` agent block.
2. Agent receives the `github.issues.opened` (or `…labeled`) envelope, checks
   the `small` label, and bails otherwise.
3. Posts to Slack `#proj-cloud` via `ctx.slack.post()` and captures `thread_ts`.
4. Claims the issue with a GitHub comment via `ctx.github.comment()`.
5. Materializes `workflows/cloud-small-issue-codex.ts` in the sandbox, invokes
   it with `ctx.workflow.run()`, and posts the PR link back to Slack + GitHub.
6. Persists per-thread state at
   `/_agents/cloud-small-issue-codex/threads/<thread_ts>.json` and
   `…/by-issue/<n>.json` so teammate replies in the Slack thread are routed
   to the model with full context.

## Files

| File          | Purpose                                                        |
| ------------- | -------------------------------------------------------------- |
| `persona.json` | Cloud deploy spec with `cloud: true`, `onEvent`, and workspace GitHub/Slack connection metadata. |
| `agent.ts` | Top-level agent declaration with GitHub/Slack deploy triggers plus the proactive runtime handler. |
| `package.json` | Runtime dependency manifest for local iteration. |

## Deploy

Deploy through the normal workforce cloud deploy path:

```bash
agentworkforce deploy ./personas/cloud-small-issue-codex --mode cloud
```

The persona resolves GitHub and Slack from the workspace integration rows so it
can use the shared AgentWorkforce/cloud GitHub app install and `#proj-cloud`
Slack connection during proactive event delivery.

`systemPrompt` is intentionally a minimal compatibility shim for cloud deploy
validation; runtime behavior and deploy triggers are driven by `agent.ts`.

## Sandbox requirements

The per-event sandbox must receive:

- `WORKFORCE_WORKSPACE_TOKEN` with `workflow:invoke:write` and
  `workflow:runs:read`.
- `WORKFORCE_CLOUD_BASE_URL`.
- Relayfile mount env for GitHub and Slack writebacks.
- Harness credentials for Slack-thread Q&A through `ctx.harness.run()`.

This persona requires `@agentworkforce/runtime` `^3.0.21` or newer, which is
the first release that includes the workflow, Slack, and harness surfaces from
workforce #136.
