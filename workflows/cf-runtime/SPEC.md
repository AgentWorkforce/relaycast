# cf-runtime architecture SPEC

Source of truth for the 7 workflows in this directory. Every task prompt
references specific sections here; change the SPEC and the workflows follow.

## Problem statement

`@agentworkforce/sage@1.4.20` dispatches Slack turn work via
`c.executionCtx.waitUntil(...)` in `src/app/slack-webhooks.ts:682`. Cloudflare
cancels `waitUntil` tasks ~30s after the HTTP request returns, so any turn
whose harness tier needs longer than that (Notion fetches, multi-tool-call
specialist routing) is silently cancelled. User sees: Sage responds to fast
prompts, goes silent on anything requiring real work. Worker metrics show 100%
success because the webhook itself always 200s.

The fix has to apply wherever a harness turn runs — so Specialist inherits the
same budget bug and must be fixed at the same time. And it has to factor
cleanly so `nightcto`, `my-senior-dev`, and future personas reuse the runtime
without duplicating plumbing.

### Why wrap-from-outside is insufficient

An early iteration of this SPEC proposed wrapping sage's default export,
intercepting the Slack webhook, enqueueing the raw request, and replaying it
inside the consumer with a fake `ExecutionContext`. That fails: sage's own
`SlackEventDedupGate` (at `src/app/slack-webhooks.ts:553`) would match the
replayed delivery and short-circuit before dispatch runs — the bug just
moves. It also hides a design smell: sage currently owns a primitive (Slack
event dedup) that `@agent-assistant/surfaces` already exports
(`SlackEventDedupGate`, header literally notes it was *"ported from sage so
every consumer gets the same guarantee"*). That duplication means every new
persona re-implements dedup instead of inheriting it.

The correct fix is to factor sage so ingress and turn execution are
separately callable, and to move dedup ownership into the ingress layer —
where it belongs for every persona.

## Design principles

1. **Reuse the existing continuation runtime** (`@agent-assistant/continuation`).
   Every hard problem — suspend / resume, redelivery, trigger matching,
   delivery state machine — is already solved upstream. We build **CF-specific
   adapters** onto those interfaces, not a parallel system.
2. **Platform split mirrors `relayauth`**: platform-agnostic OSS packages in
   `agent-assistant/packages/*`; CF-specific Env types and DO subclasses in
   `cloud/packages/cloudflare-agent-bindings`. No `cloudflare:workers`
   imports from the agent-assistant monorepo.
3. **Continuation state is authoritative.** A turn's progress lives in the
   `ContinuationStore`, not in an in-flight Worker invocation. Redeploy at any
   moment → next invocation picks up from store state.
4. **Ingress is thin.** Webhook handlers verify signatures, enqueue, ACK. All
   actual work happens in queue consumers, which are scheduled via
   `ContinuationSchedulerAdapter`.
5. **Sage↔Specialist is async by construction.** No synchronous HTTP call
   inside a turn. Sage's harness suspends waiting on a
   `specialist_result:<turnId>` trigger; Specialist's turn completes, fires
   the trigger, and Sage resumes in a fresh invocation.
6. **Dedup is owned by the ingress layer, once per delivery.** Personas must
   not implement their own Slack/GitHub event dedup; they inherit
   `SlackEventDedupGate` (from `@agent-assistant/surfaces`, or wherever W4
   lands the canonical home) via the cf-runtime ingress wrapper. A turn
   descriptor that survives ingress is, by contract, deduped — the consumer
   does not need to re-check.
7. **Personas expose an ingress/turn split.** Every persona npm package
   (sage, nightcto, my-senior-dev, …) exports two functions per surface:
   `parse<Surface>Webhook(req, env): Promise<TurnDescriptor>` for the
   ingress side (signature verify + parse + any persona-specific policy
   like rate limit; returns the turn descriptor) and
   `run<Persona>Turn(descriptor, env, ctx): Promise<void>` for the
   turn-execution side (called from the queue consumer; synchronous in the
   sense that it does not orphan work via `waitUntil`). The legacy
   `default { fetch, scheduled }` export remains for local dev but is a
   thin composition of the two.

## Package layout (new + changed)

### `agent-assistant/packages/cloudflare-runtime/` (new)

```
src/
  index.ts                              # re-exports
  ingress/
    cf-ingress.ts                       # wrapCloudflareWorker(innerWorker, opts)
    cf-ingress.test.ts
    signature/
      slack.ts                          # verifySlackSignature (HMAC SHA-256)
      slack.test.ts
      github.ts                         # verifyGitHubSignature (HMAC SHA-256)
      github.test.ts
  adapters/
    cf-continuation-store.ts            # ContinuationStore on DO storage + KV fallback
    cf-continuation-store.test.ts
    cf-continuation-scheduler.ts        # ContinuationSchedulerAdapter on Queues + DO alarms
    cf-continuation-scheduler.test.ts
    cf-delivery-adapter.ts              # ContinuationDeliveryAdapter → Slack/GitHub post-back
    cf-delivery-adapter.test.ts
    cf-specialist-client.ts             # fire-and-forget + trigger-on-result
    cf-specialist-client.test.ts
  executor/
    cf-turn-executor.ts                 # queue() handler wiring the continuation runtime
    cf-turn-executor.test.ts
    fake-execution-context.ts           # the ctx shim that await-folds waitUntil
    fake-execution-context.test.ts
  do/
    turn-executor-do.ts                 # abstract DO base class (per-conversation serializer)
    turn-executor-do.test.ts
  types.ts                              # CfBindingsShape, queue message unions
package.json
tsconfig.json
vitest.config.ts
README.md
```

**Package constraints**:

- `"type": "module"`; ESM only.
- Depends on `@agent-assistant/continuation`, `@agent-assistant/webhook-runtime`
  (for `parseSlackEvent` and types). No runtime dependency on
  `@cloudflare/workers-types` — it's a `devDependency`.
- No `cloudflare:workers` imports. Durable Object base class is written
  against `DurableObject` as an abstract type, subclassed per-persona in the
  cloud repo where the DO binding actually exists.
- Public API is stable: `wrapCloudflareWorker`, `createCfContinuationRuntime`,
  `TurnExecutorDO`, signature verifiers, types.

### `agent-assistant/packages/webhook-runtime/` (modified by W4)

Two goals:

1. Factor any sage-specific assumptions out of `parseSlackEvent` so the CF
   runtime can reuse it.
2. Formalize the **persona contract**: document (and re-export / relocate as
   needed) `SlackEventDedupGate` as the sanctioned dedup primitive and
   document the `parse<Surface>Webhook` + `run<Persona>Turn` contract so
   every future persona package follows the same shape.

No breaking API change; patch-level bump. If relocating
`SlackEventDedupGate` from `@agent-assistant/surfaces` is warranted, that's a
re-export with a deprecation note on the surfaces side — not a breaking move.

### `agent-assistant/packages/sage/` (modified by W0, lives at `../sage`)

Sage is co-developed with the runtime. W0 lands these changes in the `sage`
repo and publishes `@agentworkforce/sage@1.5.0`:

- **Delete** the local `SlackEventDedupGate` copy in `src/app/slack-state.ts`
  and its invocation in `src/app/slack-webhooks.ts`. Ingress dedup is now
  upstream; sage trusts that a descriptor it receives has already been
  deduped.
- **Add exports** to `src/index.ts`:
  - `parseSlackWebhook(req: Request, env: SageBindings): Promise<SageTurnDescriptor | SageAckResponse>`
    — verifies signature (still sage's responsibility since sage owns the
    signing secret lookup), parses the event, runs any sage-specific policy
    (rate limit, thread-gate), and returns either an "ack-only" response
    (rate-limited / irrelevant event) or a turn descriptor ready to enqueue.
  - `runSageTurn(descriptor: SageTurnDescriptor, env: SageBindings, ctx: ExecutionContext): Promise<void>`
    — runs the harness work synchronously relative to the caller. Any
    internal use of `ctx.waitUntil` is for legitimately out-of-band work
    only (telemetry, eyes-reaction); the *turn* itself is awaited.
  - `SageTurnDescriptor` type and associated helpers.
- **Keep** `default { fetch, scheduled }` for local dev + backward compat.
  Internally composes the split with an in-memory dedup — cloud consumers
  migrate to the split (W6), but `createSageApp()` still works for tests
  and standalone deploys.

### `cloud/packages/cloudflare-agent-bindings/` (new, Cloud repo)

```
src/
  env.ts                # CfAgentEnv<TPersona> generic env type: Queues, KV, DO namespaces
  turn-executor-do.ts   # concrete DO class subclassing TurnExecutorDO<PersonaHarness>
  queue-producer.ts     # helper for typed queue sends from the ingress worker
package.json
tsconfig.json
```

This is the *CF-aware* layer. It imports from `@cloudflare/workers-types`,
`cloudflare:workers`, and the new `@agent-assistant/cloudflare-runtime`, and
exposes the typed surface that each persona worker consumes.

### `cloud/infra/agent-persona.ts` (new)

```ts
export interface AgentPersonaInputs {
  name: string;                                  // "sage" | "nightcto" | ...
  handler: string;                               // path to worker entrypoint
  domain: $util.Input<string>;
  webhooks: ("slack" | "github" | "nango")[];
  secrets: Record<string, sst.Secret>;
  specialists?: Record<string, sst.cloudflare.Worker>;  // service bindings
  environment?: Record<string, $util.Input<string>>;
}

export function defineAgentPersona(inputs: AgentPersonaInputs): {
  worker: sst.cloudflare.Worker;
  turnQueue: sst.cloudflare.Queue;
  deadLetterQueue: sst.cloudflare.Queue;
  kvs: { dedup, threads, prefs, signals, quietHours, continuations: sst.cloudflare.Kv };
  turnExecutorDo: $util.Output<string>;          // DO class name, for binding downstream
};
```

Provisions: ingress Worker + producer binding to `TurnQueue`; consumer binding
on same Worker; `DeadLetterQueue` for failed turns; 6 KVs (5 existing + new
`continuations` KV); `TurnExecutorDO` namespace for per-conversation
serialization; specialist service bindings.

### `cloud/packages/sage-worker/src/worker.ts` (rewritten by W6)

Consumes sage's new split exports (landed in W0). No replay, no black-box
`sage.fetch` call:

```ts
import { parseSlackWebhook, runSageTurn } from "@agentworkforce/sage";
import {
  wrapCloudflareWorker,
  handleCfQueue,
  verifySlackSignature,
} from "@agent-assistant/cloudflare-runtime";
import { createTurnExecutorDoClass } from "@cloud/cloudflare-agent-bindings";

export const SageTurnExecutor = createTurnExecutorDoClass({
  name: "SageTurnExecutor",
  buildExecutorOptions: (env) => ({
    // Consumer turn: call sage directly with the fake ctx.
    harnessAdapter: (env) => ({
      runTurn: (descriptor, ctx) => runSageTurn(descriptor, env, ctx),
    }),
    // store, scheduler, delivery adapters...
  }),
});

const wrapped = wrapCloudflareWorker({
  webhookRoutes: {
    "/api/webhooks/slack": {
      provider: "slack",
      verify: verifySlackSignature,
      parse: (req, env) => parseSlackWebhook(req, env),
    },
  },
  queueBinding: "TURN_QUEUE",
  dedupBinding: "DEDUP",           // ingress dedup — SlackEventDedupGate
  continuationBinding: "CONTINUATIONS",
  turnExecutorDoBinding: "SAGE_TURN_EXECUTOR",
});

export default {
  fetch: wrapped.fetch,
  queue: (batch, env, ctx) => handleCfQueue(batch, env, ctx, /* opts */),
};
```

### `cloud/packages/specialist-worker/src/index.ts` (modified by W7)

Same shape as sage-worker: wrap existing Hono app with
`wrapCloudflareWorker`, add a DO class export, subscribe to the queue for
async specialist calls.

## Interface contracts

All upstream types unchanged. CF adapters implement these from
`@agent-assistant/continuation`:

- `ContinuationStore`: `create`, `get`, `update`, `delete`, `findByTrigger`.
  CF impl: DO storage (`state.storage.put/get/delete`) scoped by conversation
  id; KV used only for the secondary-index `{trigger → continuation id}`
  lookup.
- `ContinuationSchedulerAdapter`: `schedule(at)`, `cancel(id)`. CF impl:
  `state.storage.setAlarm()` for same-DO wakeups, `TURN_QUEUE.send({type:
  "wake", id}, {delaySeconds})` for cross-DO wakeups.
- `ContinuationDeliveryAdapter`: `deliver(target, payload)`. CF impl:
  switch on `target.kind`: "slack" → Slack Web API post;
  "github" → GitHub App post; "a2a-callback" → POST to specialist's
  callback URL (or service-binding fetch).
- `ContinuationHarnessAdapter`: wraps the persona's harness so a turn can
  suspend. CF impl is a thin delegator — the harness itself lives in the
  persona npm package.

## Queue message schema

```ts
type TurnQueueMessage =
  | { type: "webhook", provider: "slack" | "github" | "nango",
      body: string, headers: Record<string, string>, url: string,
      receivedAt: string }
  | { type: "resume", continuationId: string, trigger: ContinuationResumeTrigger }
  | { type: "specialist_call", turnId: string, capability: string,
      input: unknown, callbackTrigger: ContinuationResumeTrigger }
  | { type: "specialist_result", callbackTrigger: ContinuationResumeTrigger,
      result: unknown, error?: { message: string, code?: string } };
```

Dead-letter queue receives messages after N attempts (default 5). Each message
includes its origin `turnId` so DLQ triage can post back to Slack with a
user-visible failure.

## Invariants (violation = bug)

1. `ctx.waitUntil(promise)` inside a consumer handler MUST be equivalent to
   `await promise` — the fake ctx collects into an array that the consumer
   awaits before returning. Never orphan a promise past consumer return.
2. A turn that suspends MUST write its continuation to the store before the
   consumer returns. Losing the continuation = losing the turn.
3. Signature verification happens at the boundary that owns the secret.
   For Slack, that's currently sage (it owns the per-workspace signing
   secret lookup). The cf-runtime ingress delegates verification to the
   persona's `parse<Surface>Webhook`. Ingress code does not short-circuit
   verification.
4. **Dedup runs exactly once, at the ingress edge, owned by the cf-runtime
   wrapper.** It uses the upstream `SlackEventDedupGate` primitive.
   Personas MUST NOT re-implement dedup; a turn descriptor that arrives at
   the consumer is deduped by construction.
5. The DO per-conversation is the ONLY writer for that conversation's
   continuation records. KV index is eventually consistent and used only as
   a hint for cross-DO wakeups.
6. **Personas are a two-function contract.** Each persona package exports
   `parse<Surface>Webhook` (ingress side) and `run<Persona>Turn` (consumer
   side). Nothing else about the persona runtime shape is assumed by
   cf-runtime.

## Regression test contract

Every workflow touching runtime code adds (or validates the presence of) a
**replay harness test**:

```ts
// Given: a real persona harness that suspends twice (specialist call + approval)
// And: a synthetic request delivered to CfIngress
// When: the turn is fully executed via CfTurnExecutor with a fake
//       ExecutionContext whose waitUntil collects-and-awaits
// Then: the final delivery call is made to the delivery adapter
// And: no promise is orphaned (ctx.waitUntil count == resolved count)
// And: all continuation records are in terminal state
```

This is the direct regression test for the Slack-silence bug. It runs in
`@agent-assistant/cloudflare-runtime`'s vitest suite and is re-run (against
the installed version) by W6 and W7 as a smoke test.

## Non-goals (out of scope for this bundle)

- ~~Modifying `@agentworkforce/sage` itself.~~ *(Revised: sage IS modified in
  W0 — split into `parseSlackWebhook` + `runSageTurn`, local dedup removed.
  The v1 plan attempted to avoid sage changes via a replay-with-fake-ctx
  wrapper, which would have hit sage's own dedup and silently no-op'd.)*
- Migrating specialists (Linear/GitHub) to their own workers. They stay in
  `packages/specialist-worker` for now; the runtime just gives each turn a
  proper budget.
- Cloudflare Workflows. Evaluated, rejected for v1 because the continuation
  package already provides the semantics we need. Revisit if we hit >15 min
  wall-time turns in production.
- **Cataloging agents** (`packages/cataloging-agent-github`,
  `packages/cataloging-agent-linear`, `@cloud/cataloging-agent-core`). These
  are a different workload shape — cron-driven (`*/30 * * * *`), pull-based,
  non-user-facing. They already have their own framework
  (`createCatalogingAgent`) and their own DO (`CatalogingSubscriber`), and
  they don't suffer the Slack-silence failure mode (a slow sync just retries
  on the next cron, nobody is waiting on a reply). Leaving them alone keeps
  scope sharp.
  **Reusable primitives for them later**: if a catalog sync ever exceeds a
  single DO-alarm budget, `CfContinuationStore` + `CfContinuationScheduler`
  from W2 are directly reusable — no new abstractions required. A v2
  consolidation could factor a single `defineAgent({ trigger: "webhook" |
  "cron" })` that both `defineAgentPersona` and `createCatalogingAgent`
  collapse into; that's explicitly out of scope for this bundle.

## Glossary

- **Turn**: one harness execution, potentially spanning multiple Worker
  invocations via continuations.
- **Ingress**: the HTTP-facing part of the worker. Verifies, enqueues, ACKs.
- **Consumer**: the `queue()` handler. Runs a turn (or a segment of one).
- **Conversation**: Slack thread or GitHub issue or similar. One DO instance
  per conversation serializes writes.
- **Trigger**: a named event a continuation waits on
  (`specialist_result:<turnId>`, `approval:<requestId>`, etc.).
- **Delivery**: the final post-back to the user surface (Slack message,
  GitHub comment, etc.) that concludes a turn.
