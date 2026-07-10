# Slack Conversational Agent Routing — Phase 2 SPEC (go-live)

Source of truth for `workflows/slack-conversational-routing-p2.ts`. All agents
implementing this feature must read this file first, then read the Phase 1
artifacts it builds on (PR #1894, `workflows/slack-conversational-routing-SPEC.md`).

## §1 Current state after Phase 1 (traced 2026-06-04, post PR #1894)

Phase 1 shipped the routing + ack + enqueue seam, dark behind
`isSlackConversationRoutingEnabled()`. With the flag ON today the flow is:

1. Slack `app_mention` → `handleSlackRelayfileForward` →
   `dispatchIntegrationWatchEvent`
   (`packages/web/lib/proactive-runtime/integration-watch-dispatcher.ts` —
   conversational arm at ~:1431-1450 calls
   `maybeDispatchSlackConversationalAppMention` from
   `packages/web/lib/integrations/slack-conversation/dispatch.ts`).
2. Router selects the conversational persona; ONE ack is posted via the
   Phase 1 egress (`packages/web/lib/integrations/slack-conversation/egress.ts`,
   type-bound to `@agent-assistant/surfaces` `SlackProgressStreamEgress`).
3. Delivery enqueued via `enqueueIntegrationWatchDelivery`
   (`packages/web/lib/proactive-runtime/integration-watch-deliveries.ts:149-189`)
   with payload marker `slackConversation: { channel, threadTs?, ackTs?, selectedVia }`.
4. Drain: `drainIntegrationWatchDeliveries` (`integration-watch-deliveries.ts:773-974`)
   → fresh launches via `deliverDeploymentTrigger` (call at :847-856), async
   completion via `pollDeploymentTriggerRun`
   (`packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts:3297-3605`).
5. **Dead end (the Phase 2 gap):** the run completes, output is captured at
   `deployment-trigger-delivery.ts:3522-3523`
   (`getScriptLogs` → `deploymentRunOutputFromLogs`), terminal hooks fire for
   Linear (`postLinearAgentSessionTerminalWriteback` calls at :3388, :3467,
   :3562) — but NOTHING consumes the `slackConversation` marker. The user gets
   an ack and never a reply.
6. The dispatcher's `threadOwnerLookup` seam is wired to a stub returning
   `null` (`dispatch.ts` `lookupSlackConversationThreadOwner`), so thread
   stickiness does not exist.
7. The `SlackConversationRoutingEnabled` SST secret is intentionally
   unregistered, so the flag cannot be flipped in deployed environments.

Phase 2 closes exactly these three gaps. After this PR merges and the secret
is set, the feature is live end-to-end for `app_mention`.

## §2 Phase 2 scope

- **D1** — terminal Slack reply: a post-run hook that reads the
  `slackConversation` marker and posts the run outcome into the thread.
- **D2** — thread stickiness: a real `threadOwnerLookup` backed by a new
  `slack_conversation_threads` table, with owner recording on successful
  routed dispatch.
- **D3** — full SST registration of `SlackConversationRoutingEnabled`
  (seven-place wiring) so the flag is flippable per stage.
- **D4** — go-live runbook artifact.
- **D5** — tests for all of the above.

## §3 Non-goals (explicit Phase 3 follow-ups, do NOT build now)

- True token-streaming of the model turn into Slack (`appendStream` driven by
  the harness `streamStep` bridge). Phase 2 posts the terminal outcome only.
- Continuation-store resumption (`createSlackUserReplyContinuation`,
  `packages/web/lib/proactive-runtime/continuation-create.ts:29-128`). Phase 2
  conversation continuity = follow-up `app_mention` in the same thread routes
  to the same agent via D2 and starts a fresh run.
- DM (`message.im`) routing.
- Any change to ingestion/normalization (`handleSlackRelayfileForward`).

## §4 D1 — terminal Slack reply

New file: `packages/web/lib/proactive-runtime/slack-conversation-terminal-reply.ts`.

Mirror the shape and call discipline of `postLinearAgentSessionTerminalWriteback`
(the prior art for posting a run outcome back to a surface — see its call
sites in `pollDeploymentTriggerRun` at `deployment-trigger-delivery.ts:3388,
:3467, :3562`).

Contract:

    postSlackConversationTerminalReply(input: {
      workspaceId: string;
      payload: unknown;                  // the delivery payload — extract slackConversation defensively
      outcome:
        | { kind: "completed"; output: string }
        | { kind: "failed"; reason: string }   // error / timeout / sandbox_terminal
      deps?: {                           // injected for tests
        egress?: Pick<SlackConversationProgressStreamEgress, "startStream">;
        routingEnabled?: () => boolean;
      };
    }): Promise<void>

Behavior requirements:

- Extract `slackConversation` from the payload defensively (unknown-shaped
  records; missing/invalid marker → silent no-op, NOT an error).
- Gate on `isSlackConversationRoutingEnabled()` so the hook is dead code while
  the flag is off (same dormant discipline as the dispatch side).
- `completed` → post the output as ONE threaded message via egress
  `startStream` with `threadTs = marker.threadTs ?? marker.ackTs`. Truncate to
  3,900 characters on a line boundary with a `… (truncated)` suffix. Empty
  output → post a short "completed with no output" notice.
- `failed` → post a one-line failure notice (no stack traces, no internals —
  the reason category only).
- NEVER throw into the poll/drain path: every egress call is caught; failures
  are logged via the structured `logger.warn` with
  `area: "integration-watch-dispatch"`, `diag: "slack-conversation-terminal-reply-failed"`.
- Wire the hook into EVERY terminal path of `pollDeploymentTriggerRun` that
  currently calls `postLinearAgentSessionTerminalWriteback` (:3388 error,
  :3467 timeout, :3562 completed — verify exact sites against the current
  file; they may have shifted a few lines), plus the synchronous-completion
  path in `deliverEnvelopeToSandbox` if it has its own terminal hooks. The
  dispatcher/poll diff must be additive and small — one hook call per terminal
  site, no restructuring.
- The model turn must NOT run inline in the webhook context (CF Worker
  waitUntil kill class, cloud#1808). The hook runs at drain/poll time, which
  already executes in the sweep/queue context — keep it there.

## §5 D2 — thread stickiness

New table + module + dispatcher wiring.

**Migration** (`packages/web/drizzle/0084_slack_conversation_threads.sql` — use
the next free number at implementation time; check `ls packages/web/drizzle/`):

    CREATE TABLE IF NOT EXISTS "slack_conversation_threads" (
      "workspace_id" text NOT NULL,
      "channel" text NOT NULL,
      "thread_ts" text NOT NULL,
      "deployed_name" text NOT NULL,
      "agent_id" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("workspace_id", "channel", "thread_ts")
    );

- Add the matching drizzle table to `packages/web/lib/db/schema.ts` (mirror
  `proactiveContinuations` at ~:550 for style).
- Update `packages/web/drizzle/meta/_journal.json` in the SAME change: next
  `idx` (last is 83 / `0083_provider_credentials_email_active`; re-check at
  implementation time), `when` strictly greater than the previous entry
  (last is 1780570000000), matching `tag`. `npm run web:drizzle-journal:test`
  MUST pass — a migration without a journal entry silently skips in deploys
  (repo rule, CLAUDE.md "Web Drizzle Migrations").

**Module**: `packages/web/lib/integrations/slack-conversation/threads.ts`:

    lookupSlackConversationThreadOwner({ workspaceId, channel, threadTs }): Promise<string | null>
    recordSlackConversationThreadOwner({ workspaceId, channel, threadTs, deployedName, agentId }): Promise<void>

- DB access via `getDb()` like neighboring modules; both functions are
  fail-open: a DB error logs a structured warning and returns null / resolves
  (a stickiness miss must never break dispatch).
- `recordSlackConversationThreadOwner` upserts (ON CONFLICT of the PK →
  update `deployed_name`, `agent_id`, `updated_at`).

**Dispatcher wiring** (additive, in the conversational arm only):

- Replace the stub `threadOwnerLookup` with the real lookup (workspaceId comes
  from dispatch input; keep the seam injectable for tests).
- After a successful routed dispatch (selection `selected` AND delivery
  enqueued as queued/delivered), record the owner with
  `threadTs = event.threadTs ?? ackTs`. Recording with the ackTs anchors the
  thread the ack started, so follow-up mentions in that thread stick to the
  same agent. Fire-and-forget with catch — never block or fail dispatch on the
  recording write.

## §6 D3 — SST secret registration (seven places)

Register `SlackConversationRoutingEnabled` per the CLAUDE.md "Adding a new SST
resource" rule. The consuming helper already exists and is Resource-first
(`packages/web/lib/integrations/slack-conversation/flag.ts`), so step 3 is
done. Remaining:

1. Declare in `infra/secrets.ts`:
   `const slackConversationRoutingEnabled = new sst.Secret("SlackConversationRoutingEnabled")`
   — follow the file's existing declaration + export style.
2. Link from BOTH `infra/web.ts` and `infra/web-worker.ts` (the dispatcher
   runs on the Worker; the boot check runs on both).
3. (done — flag.ts reads `tryResourceValue("SlackConversationRoutingEnabled")` first.)
4. Add to `scripts/set-secrets.sh` mapping env var
   `CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED` → secret, following the
   surrounding entries.
5. Add the env var to `.github/workflows/_deploy-cloud-stage.yml` — BOTH the
   `inputs.secrets:` declaration and the `deploy` job `env:` block.
6. Add to `.github/workflows/preview.yml` and seed in
   `.github/scripts/seed-sst-secrets.sh` with a harmless non-empty
   preview-disabled placeholder (use `set_secret_or_default … "disabled"` —
   "disabled" is non-empty so SST deploy and boot checks pass, and
   `truthyFlag` treats it as OFF).
7. Add `{ name: "SlackConversationRoutingEnabled", kind: "secret" }` to
   `SHARED_SST_SECRETS` in `packages/web/lib/boot/resource-check.ts`
   (~:44-85; it is read on both Lambda and Worker).

Gate: `bash .github/scripts/validate-secret-wiring.sh` MUST pass — it catches
drift between set-secrets.sh, the deploy workflow, preview.yml, and the seeder.

NOTE: the GitHub Actions secret VALUE is an operator action (the runbook, §7)
— this PR only wires the plumbing. The secret being unset/empty everywhere
keeps the feature OFF, which is the required dormant state at merge.

## §7 D4 — go-live runbook

Write `docs/runbooks/slack-conversational-routing-golive.md`:

1. Merge this PR; CI deploys with the secret unset → feature still OFF
   (verify: boot check line in CloudWatch shows the binding present; flag
   evaluates false on empty).
2. Create the GitHub Actions secret `CLOUD_SLACK_CONVERSATION_ROUTING_ENABLED=true`
   for the target stage; run the stage deploy workflow (never a manual prod
   deploy — repo rule).
3. Deploy a test persona with the `conversational` capability
   (`capabilities: { conversational: { defaultResponder: true } }`) to one
   workspace.
4. E2E probe: @-mention the Slack app in a test channel → expect ONE ack, the
   agent run, ONE threaded terminal reply, and a `slack_conversation_threads`
   row; a follow-up mention in the thread must route to the same agent
   (`selectedVia: "thread"`).
5. Rollback: set the secret value to empty/`disabled` and redeploy the stage —
   the entire path goes dark again (dispatch AND terminal reply are both
   flag-gated).

## §8 D5 — test contract

New tests under `tests/proactive-runtime/slack-conversation/` plus the
journal/wiring gates:

- `terminal-reply.test.ts`: marker extraction from unknown payloads (missing /
  malformed → no egress call), completed posts threaded text with
  `threadTs ?? ackTs`, truncation at 3,900 chars with suffix, empty-output
  notice, failed posts one-line notice, egress failure logged + swallowed
  (never rejects), flag OFF → no egress call.
- `threads.test.ts`: lookup returns null on no row / DB error (fail-open),
  record upserts and second record updates the owner, lookup returns the
  recorded owner. Use injected/mocked db following the style of neighboring
  pglite or mock-db tests (`deployment-tick-deliveries.pglite.test.ts` is the
  pglite prior art if a real-schema test is warranted).
- Extend `dispatcher-flag.test.ts`: flag ON + selected + queued → thread owner
  recorded with `event.threadTs ?? ackTs`; recording failure does not fail
  dispatch; flag ON + existing thread owner → `selectedVia: "thread"` for the
  sticky agent; flag OFF → no lookup, no recording (byte-identical proof stays
  green).
- Hook-site coverage: extend the existing dispatcher/poll test seam (or add a
  focused unit) proving `postSlackConversationTerminalReply` is invoked from
  the completed AND failed poll paths with the delivery payload, and that a
  rejecting reply hook does not fail the poll.
- Wiring gates (deterministic, not unit tests):
  `npm run web:drizzle-journal:test` and
  `bash .github/scripts/validate-secret-wiring.sh`.

Test runner: same repo convention —
`npx tsx --test tests/proactive-runtime/slack-conversation/*.test.ts`.

## §9 Constraints and repo rules (binding)

- Dormant at merge: secret unset everywhere → flag OFF → Phase 2 code paths
  (terminal reply, thread recording) are all unreachable. The flag-off
  byte-identical dispatch test from Phase 1 must stay green untouched.
- The egress contract is type-bound to `@agent-assistant/surfaces`
  (`SlackConversationProgressStreamEgress extends SlackProgressStreamEgress`).
  Do NOT fork or re-mirror it; consume the Phase 1 egress as-is.
- SST secrets only via Resource-first helpers (`.claude/rules/sst-secrets.md`);
  never bare `process.env` in deployed code paths.
- Drizzle migration + `_journal.json` in the same change
  (`npm run web:drizzle-journal:test` green before PR).
- `tsconfig` has `exactOptionalPropertyTypes` — build optional-property objects
  with conditional spreads, not `key: maybeUndefined`.
- The diff to `deployment-trigger-delivery.ts` and
  `integration-watch-dispatcher.ts` must be additive and minimal — these are
  hot production paths; no restructuring, no moved functions.
- COMMIT COMPLETENESS (Phase 1 post-mortem): Phase 1's scoped commit MISSED a
  new file under `packages/web/lib/proactive-runtime/` because the scope-path
  list didn't cover that directory, shipping a PR whose dispatcher imported an
  uncommitted module. Every implementer posts the FULL list of files it
  created/modified to the channel; the commit step stages the explicit scope
  list below; the post-commit gate fails on ANY remaining dirty/untracked
  `.ts/.sql/.json/.sh/.yml/.md` file outside log/artifact dirs, and the repair
  step must stage what it finds (into the scoped commit) or justify in the PR
  body why a file is intentionally excluded.

## §10 Acceptance contract

1. `npx tsx --test tests/proactive-runtime/slack-conversation/*.test.ts` green
   (Phase 1 + Phase 2 tests).
2. `npx tsx --test tests/proactive-runtime/capabilities.test.ts` green.
3. `npm run typecheck` green.
4. `npm run web:drizzle-journal:test` green.
5. `bash .github/scripts/validate-secret-wiring.sh` green.
6. Regression: `npx tsx --test tests/proactive-runtime/*.test.ts`,
   `npm run web:webhook-ingress:test`, `npm run web:proactive-runtime:test` green.
7. New files exist: `slack-conversation-terminal-reply.ts`,
   `slack-conversation/threads.ts`, the migration + journal entry, the runbook,
   and the new test files.
8. `infra/secrets.ts`, `infra/web.ts`, `infra/web-worker.ts`,
   `scripts/set-secrets.sh`, `_deploy-cloud-stage.yml`, `preview.yml`,
   `seed-sst-secrets.sh`, and `resource-check.ts` all reference
   `SlackConversationRoutingEnabled` (grep-verifiable).
9. Post-commit completeness gate (§9) green.
