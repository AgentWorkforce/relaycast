# Wave D / Step 06 — sage-worker cutover to `@agent-assistant/cloudflare-runtime`

## Goal

Eliminate the production Slack-silence bug by moving sage's Slack turn execution off `ctx.waitUntil(...)` and onto the queue + Durable Object pattern provided by `@agent-assistant/cloudflare-runtime` (introduced in agent-assistant#56).

Acceptance contract (must all hold in production after deploy):

1. A Slack DM that triggers a multi-tool harness turn (e.g. *"what PRs are open in cloud?"*) **always produces a Slack reply** in the thread — either the real answer, or a graceful fallback message. No more silent threads.
2. `wrangler tail sage` does **not** emit `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled` for normal user traffic.
3. `[sage] Dropping thread reply on inactive thread` no longer fires for threads where the original turn never completed (the second-order effect of the silence bug — once turns complete reliably, the thread gate stays active and follow-ups don't get dropped).

## Non-goals

- Refactoring the harness or specialist-worker. Out of scope.
- Changing what tools sage calls or what model it uses.
- Sage-side code changes beyond the parseSlackWebhook / runSageTurn surface that 1.5.x already exposes. If the cf-runtime contract requires a sage tweak, treat it as a separate sage PR; this workflow does not modify sage source.
- Changing observability or metrics infrastructure beyond the JSON logger that cf-runtime already wires up.

## Background

Sage's Slack ingress today (`sage/src/app/slack-webhooks.ts:844`):

```ts
c.executionCtx.waitUntil(
  runSageTurnFromHandler(result.turn, c.env, c.executionCtx, undefined, options),
);
return result.response;
```

Cloudflare Workers cancels `waitUntil` tasks shortly after the response returns. A multi-tool harness turn (router → specialist → cloud `/api/v1/github/query` → reply) regularly exceeds that budget, so the worker is killed before reaching `slack.postMessageChunked(...)`. The user sees no reply in the thread.

`@agent-assistant/cloudflare-runtime` was built for exactly this: it lifts turn execution into a Queue + Durable Object pair so the work runs on the full Workers wall budget, decoupled from the HTTP request lifecycle. PR #56's body is explicit: *"this is the direct fix for the production Slack-silence bug."*

## Architecture

```
                   Slack
                     │
                     ▼  POST /api/webhooks/slack
       ┌─────────────────────────────────┐
       │ cloud/packages/sage-worker      │
       │   wrapCloudflareWorker          │
       │     parse via                   │
       │     sage.parseSlackWebhook      │
       │     enqueue WebhookQueueMessage │
       │     return 200 OK to Slack      │
       └─────────────────┬───────────────┘
                         │
                         ▼
                ┌──────────────────┐
                │ TURN_QUEUE       │   (Cloudflare Queue)
                │   (sage-turns)   │
                └────────┬─────────┘
                         │
                         ▼
       ┌─────────────────────────────────┐
       │ queue handler: handleCfQueue    │
       │   route by message.type         │
       │   forward to TurnExecutorDO     │
       └─────────────────┬───────────────┘
                         │
                         ▼
       ┌─────────────────────────────────┐
       │ TurnExecutorDO                  │
       │   one DO per Slack thread       │
       │   call sage.runSageTurn(...)    │
       │   on completion: post via       │
       │   CfDeliveryAdapter             │
       └─────────────────────────────────┘
```

Idempotency key: Slack event_id (already used by `SlackEventDedupGate` from `@agent-assistant/surfaces`). cf-runtime owns the dedup at the ingress layer when `dedupBinding` is configured — same KV namespace that today's `c.env.DEDUP` points at.

DO partitioning: one Durable Object instance per `${workspaceId}:${threadTs ?? eventTs}`. Concurrent messages on the same thread serialize through one DO; different threads run in parallel.

## SST infra changes (`cloud/infra/sage.ts`)

New bindings on the sage worker:

1. **Queue producer** — `TURN_QUEUE` bound to a new `sst.cloudflare.Queue("SageTurnQueue", { ... })`.
2. **Queue consumer handler** — same worker exports `queue(batch, env, ctx)` so messages route back to the same script (no separate consumer worker).
3. **Dead-letter queue** — `DEAD_LETTER_QUEUE` for messages that exceed retry budget. Keeps poison messages out of the live queue.
4. **Durable Object** — `TURN_EXECUTOR_DO` bound to the `TurnExecutorDO` class exported from the sage-worker entrypoint.
5. **DO migration** — first-time class registration:
   ```jsonc
   {
     "tag": "v1",
     "new_classes": ["TurnExecutorDO"]
   }
   ```
   This is **forward-only**. Renaming the class in a later migration requires a `renamed_classes` entry; deletion requires `deleted_classes`. Get the name right on day one.
6. **Continuation KV** (optional first cut) — `CONTINUATIONS` for `CfContinuationStore` if the harness ever yields mid-turn. Can be stubbed (not bound) on initial deploy; sage's current single-shot turns don't need it.

Existing bindings (`DEDUP`, `THREADS`, `PREFS`, `SIGNALS`, `QUIET_HOURS`, secrets) all carry forward unchanged — sage's `runSageTurn` still consumes them via the env object.

## sage-worker entrypoint (`cloud/packages/sage-worker/src/worker.ts`)

Today:

```ts
export { default } from "@agentworkforce/sage";
```

After:

```ts
import {
  wrapCloudflareWorker,
  handleCfQueue,
  TurnExecutorDO,
} from "@agent-assistant/cloudflare-runtime";
import {
  parseSlackWebhook,
  runSageTurn,
} from "@agentworkforce/sage";
import type { SageBindings } from "@agentworkforce/sage";

type Env = SageBindings & {
  TURN_QUEUE: Queue;
  DEAD_LETTER_QUEUE?: Queue;
  TURN_EXECUTOR_DO: DurableObjectNamespace;
};

const sageWorker = wrapCloudflareWorker<Env>({
  webhookRoutes: {
    "/api/webhooks/slack": {
      provider: "slack",
      parse: async (req, env) => {
        const result = await parseSlackWebhook(req as Request, env);
        return {
          kind: result.kind,
          response: result.response,
          turn: result.turn,
          dedupKey: result.turn?.slackEvent
            ? { eventId: result.turn.slackEvent.eventId, ts: result.turn.slackEvent.ts }
            : undefined,
        };
      },
    },
  },
  queueBinding: "TURN_QUEUE",
  dedupBinding: "DEDUP",
  turnExecutorDoBinding: "TURN_EXECUTOR_DO",
});

export default {
  fetch: sageWorker.fetch!,
  queue: handleCfQueue<Env>({
    runTurn: async (descriptor, env, ctx) => {
      await runSageTurn(descriptor as any, env, ctx);
    },
  }),
};

export { TurnExecutorDO };
```

> Exact shape of the `runTurn` adapter and how `handleCfQueue` invokes the DO is to be determined by reading `packages/cloudflare-runtime/src/executor/cf-turn-executor.ts` and `packages/cloudflare-runtime/src/do/turn-executor-do.ts` during implementation. Codex implementer: pin the contract from the source, not from this sketch.

## Cutover plan

This is a **single big-bang cutover** — feature-flagging the worker entrypoint is more dangerous than helpful here because the two paths share KV/DO state and can race.

Sequence:

1. Land this PR on cloud `main`.
2. Verify the SST plan (`cd cloud && npm run sst:plan`) cleanly shows the new Queue + DO + migration.
3. Merge → CI deploys to production.
4. Within 5 minutes of deploy:
   - Send a Slack DM to sage. Confirm reply lands.
   - `wrangler tail sage` confirms no `waitUntil()` cancellation warnings.
   - `wrangler tail sage` confirms `[sage] Reply posted` for the test message.
5. If broken, rollback path below.

The cf-runtime ingress will dedup new webhooks against `DEDUP` KV the same way the old path does, so in-flight Slack retries during the deploy window won't double-fire.

## Rollback plan

If the queue consumer crashloops or DOs misbehave on day one:

1. **Fast rollback** — revert this PR on cloud `main` and redeploy. The previous worker.ts (`export { default } from "@agentworkforce/sage"`) goes back; sage's existing `ctx.waitUntil(...)` resumes serving (silently failing on long turns, but not down-down).
2. **DO cleanup** — the new DO migration created instances. They'll be orphaned but harmless; a follow-up migration with `deleted_classes: ["TurnExecutorDO"]` cleans them when we're ready.
3. **Queue drain** — any messages still on `TURN_QUEUE` at rollback time are stranded. Drain via `wrangler queues consumer pause sage-turns` then a one-shot purge worker, OR let the dead-letter eventually swallow them after the retry budget expires.

## Smoke test (the workflow's gating step)

Before opening the PR, the workflow runs these gates in order:

1. `npx tsc -p packages/sage-worker/tsconfig.json --noEmit` — sage-worker typecheck clean.
2. `npm run build -w @agentworkforce/sage-worker` — bundles cleanly, no missing imports for `wrapCloudflareWorker` / `TurnExecutorDO` / `handleCfQueue`.
3. `npm run sst:plan -- --stage=preview` (if available) — SST plan parses the new Queue + DO bindings and emits a forward-only migration JSON.
4. `node scripts/probe-sage-worker-bundle.mjs` (if present) — sage worker bundle probe still passes (already part of cloud CI).

Production round-trip is the **post-deploy** smoke (step 4 of the cutover plan), not part of this workflow.

## Observability

- cf-runtime's `consoleJsonLogger` is already wired into `wrapCloudflareWorker` and emits structured JSON for ingress, queue dispatch, DO entry, and turn completion. `wrangler tail sage --format json` will show the full lifecycle per event.
- We expect to see, in order: `cf.ingress.parse_ok` → `cf.queue.enqueue` → `cf.queue.dispatch` → `cf.do.turn_started` → `[sage] Reply posted` → `cf.do.turn_finished`. Anything missing from that chain is the new debug starting point.
- The smoking-gun warning we want to NEVER see again: `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled`.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| DO class name typo on first migration | Medium | Spec the name explicitly here; verifier step in workflow greps the SST output for `TurnExecutorDO` |
| sage 1.5.x `AckOrDispatch` doesn't quite match cf-runtime `ParseResult` | Low (designed together in #122/#56) | Adapter shim in worker.ts (already sketched above); typecheck step catches drift |
| Queue messages survive rollback and crashloop new deploys | Medium | Dead-letter binding from day one; documented drain procedure |
| Local `wrangler dev` doesn't fully simulate Queue+DO pipeline | High | Smoke testing happens on staging/preview, not local. Document this clearly. |
| Cold-start re-imports `cloudflare-runtime` and re-registers DO instances | Low | DO instances are durable; re-instantiation just attaches to the existing storage |

## Out of scope

- Same cutover for `specialist-worker`. Tracked as a separate Wave D step.
- Same cutover for any future webhook surface (GitHub, Nango). The cf-runtime package supports them; this workflow only handles Slack.
- Replacing sage's local stop-reason-message helper with the published `@agent-assistant/harness@0.6.6` export (sage#126 + follow-up — independent track).
- Changes to relayfile / relayauth.

## References

- **agent-assistant#56** — feat(cloudflare-runtime): full package — *the direct fix for the production Slack-silence bug*
- **agent-assistant#58** — ci(publish): add cloudflare-runtime to runtime-core matrix
- **sage#122** — feat: split Slack handling into parseSlackWebhook + runSageTurn (1.5.0)
- **cloud#364** — chore(deps): bump @agentworkforce/sage + @agent-assistant/* for cf-runtime (Wave D dep bump prerequisite)
- **agent-assistant#60** — feat(harness): export stopReasonToUserMessage helper (independent silent-failure follow-up)
- **sage#125** — fix(specialist): forward user workspaceId to RelayAuth identity (independent silent-failure follow-up)
- **sage#126** — fix(slack): never post empty content (independent silent-failure follow-up)
