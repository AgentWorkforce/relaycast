# cf-runtime architecture diagrams

Visual companion to [SPEC.md](./SPEC.md). Numbered tags `[#N]` reference the
SPEC's `Invariants` section.

## Diagram 1 - runtime data path (steady-state happy path)

```
   Slack
     |
     | POST /api/webhooks/slack
     v
+----------------------------------------------------------------+
|  Cloudflare ingress Worker  (cloud/packages/sage-worker)       |
|  wrapCloudflareWorker(...).fetch                               |
|                                                                |
|   +-------------------------+    +--------------------------+  |
|   | parseSlackWebhook       |--->| SlackEventDedupGate [#4] |  |
|   | (sig verify [#3] +      |    | (KV: DEDUP)              |  |
|   |  parse + policy)        |    +-----------+--------------+  |
|   +-------------------------+                |                 |
|                                              | descriptor      |
|                                              v                 |
|                                  +------------------------+    |
|                                  | TURN_QUEUE.send(       |    |
|                                  |   {type:"webhook",...})|    |
|                                  +-----------+------------+    |
+----------------------------------------------+-----------------+
                                               | 200 ACK <-- back to Slack
                                               v
                            +-------------------------------------+
                            |  Cloudflare Queue: TURN_QUEUE       |
                            +------------------+------------------+
                                               |
                                               v
+----------------------------------------------------------------+
|  consumer Worker:  handleCfQueue(batch, env, ctx)              |
|                                                                |
|     routes msg --> TurnExecutorDO (per-conversation stub)      |
|                                                                |
|     +----------------------------------------------------+     |
|     |  TurnExecutorDO (cloud/cloudflare-agent-bindings)  |     |
|     |                                                    |     |
|     |   fakeExecutionContext [#1]                        |     |
|     |     waitUntil(p) -> pending.push(p); awaited       |     |
|     |     before consumer return                         |     |
|     |                                                    |     |
|     |   runSageTurn(descriptor, env, fakeCtx)            |     |
|     |     |                                              |     |
|     |     v                                              |     |
|     |   persona harness  (sage)                          |     |
|     |     |                                              |     |
|     |     v                                              |     |
|     |   CfDeliveryAdapter.deliver({kind:"slack",...})    |     |
|     |                                                    |     |
|     |   state.storage.put(continuation) [#5]             |     |
|     +----------------------------------------------------+     |
+--------------------------+-------------------------------------+
                           |
                           | Slack Web API: chat.postMessage
                           v
                         Slack reply
```

Caption: Happy-path turn. Slack hits the ingress Worker, which verifies the
signature inside the persona's `parseSlackWebhook`, dedups once at the edge,
and ACKs immediately. Real work runs inside a per-conversation DO under a fake
`ExecutionContext` that await-folds `waitUntil`, so the harness can take as
long as it needs and the final delivery still lands.

## Diagram 2 - async sage <-> specialist bridge

```
   [Sage DO: TurnExecutorDO]                   [Specialist DO]
  +----------------------------+               +-----------------------------+
  | runSageTurn (harness)      |               |                             |
  |   ... reaches tool call    |               |                             |
  |   needing specialist       |               |                             |
  |                            |               |                             |
  |   harness.suspend()        |               |                             |
  |     v                      |               |                             |
  |   CfContinuationStore      |               |                             |
  |   .create({ trigger:       |               |                             |
  |     "specialist_result:    |               |                             |
  |      <turnId>" })          |               |                             |
  |     +-> DO storage.put(    |               |                             |
  |          cont:<id>) [#5]   |               |                             |
  |     +-> KV(continuations)  |               |                             |
  |          .put("trig:       |               |                             |
  |          specialist_result:|               |                             |
  |          <turnId>"-><id>)  |               |                             |
  |                            |               |                             |
  |   CfSpecialistClient.call()|               |                             |
  |     v                      |               |                             |
  |   TURN_QUEUE.send({        |               |                             |
  |     type:"specialist_call",|               |                             |
  |     turnId, capability,    |               |                             |
  |     input, callbackTrigger})               |                             |
  |                            |               |                             |
  |   consumer returns;        |               |                             |
  |   sage Worker idle         |               |                             |
  +----------------------------+               |                             |
                |                              |                             |
                +--- queue --> specialist -->  |  handleCfQueue()            |
                                               |    runs specialist turn     |
                                               |  -> result                  |
                                               |  TURN_QUEUE.send({          |
                                               |    type:"specialist_result",|
                                               |    callbackTrigger, result})|
                                               +--------------+--------------+
                                                              |
                                                              v
                            +-----------------------------------------------+
                            |  Sage consumer wakes for "specialist_result"  |
                            |  KV.get("trig:specialist_result:<turnId>")    |
                            |    -> continuation id                         |
                            |  store.findByTrigger(trigger)                 |
                            |    -> DO storage.get(cont:<id>) [#5]          |
                            |  harness.resume(continuation, result)         |
                            |    v                                          |
                            |  ... harness finishes ...                     |
                            |    v                                          |
                            |  CfDeliveryAdapter -> Slack reply             |
                            |  store.delete(cont:<id>) (terminal)           |
                            +-----------------------------------------------+
```

Caption: A multi-step turn. Sage's harness suspends with a typed trigger key,
its continuation lives in DO storage, and the specialist call rides the queue
fire-and-forget. When specialist posts its result, the trigger key matches the
stored continuation via the KV index, sage resumes in a fresh invocation, and
delivery completes.

## Diagram 3 - package + repo layout

```
+-------------------------+  +------------------------------+  +-------------------------+
|  sage repo (../sage)    |  |  agent-assistant repo        |  |  cloud repo (this repo) |
|                         |  |  (../agent-assistant)        |  |                         |
|  @agentworkforce/sage   |  |                              |  |  @cloud/cloudflare-     |
|  - parseSlackWebhook    |  |  @agent-assistant/           |  |    agent-bindings       |
|  - runSageTurn          |  |    cloudflare-runtime        |  |  - CfAgentEnv<TPersona> |
|  - SageTurnDescriptor   |  |  - wrapCloudflareWorker      |  |  - createTurnExecutor   |
|  - default { fetch,     |  |  - handleCfQueue             |  |    DoClass(...)         |
|      scheduled }        |  |  - TurnExecutorDO (abstract) |  |  *** cloudflare:workers |
|    (compat only)        |  |  - fakeExecutionContext      |  |      [DO subclass] ***  |
|                         |  |  - CfContinuationStore       |  |                         |
|                         |  |  - CfContinuationScheduler   |  |  packages/sage-worker   |
|                         |  |  - CfDeliveryAdapter         |  |  - worker.ts (exports   |
|                         |  |  - CfSpecialistClient        |  |    SageTurnExecutor DO, |
|                         |  |  - verifySlackSignature      |  |    fetch, queue)        |
|                         |  |  - verifyGitHubSignature     |  |                         |
|                         |  |                              |  |  packages/              |
|                         |  |  @agent-assistant/surfaces   |  |    specialist-worker    |
|                         |  |  - SlackEventDedupGate       |  |  - same shape           |
|                         |  |                              |  |                         |
|                         |  |  @agent-assistant/           |  |  infra/agent-persona.ts |
|                         |  |    continuation              |  |  - defineAgentPersona   |
|                         |  |  - ContinuationStore (iface) |  |    (Worker, Queue, KVs, |
|                         |  |  - SchedulerAdapter (iface)  |  |     DO namespace,       |
|                         |  |  - DeliveryAdapter (iface)   |  |     specialist svc      |
|                         |  |  - HarnessAdapter (iface)    |  |     bindings)           |
|                         |  |                              |  |                         |
|                         |  |  @agent-assistant/           |  |                         |
|                         |  |    webhook-runtime           |  |                         |
|                         |  |  - parseSlackEvent           |  |                         |
|                         |  |  - persona contract docs     |  |                         |
|                         |  |                              |  |                         |
|  NO cloudflare:workers  |  |  NO cloudflare:workers       |  |  cloudflare:workers     |
|  imports                |  |  imports (platform-agnostic) |  |  imports LIVE HERE      |
+-------------------------+  +------------------------------+  +-------------------------+
        |                              ^                                 ^
        | publishes @agentworkforce/   | publishes @agent-assistant/*    |
        |   sage    (npm)              |   (npm)                         |
        +------------------------------+---------------------------------+
```

Caption: Three repos, one boundary rule. `agent-assistant` and `sage` are pure
TypeScript published to npm with zero `cloudflare:workers` dependency; only
`cloud` imports CF-specific runtime types and houses the concrete DO subclass
and SST infra. Mirrors the `relayauth` split in CLAUDE.md.

## Glossary

- **TurnDescriptor** - enqueueable output of `parse<Surface>Webhook` after
  signature verify, parse, and policy.
- **Trigger key** - typed string a continuation waits on, e.g.
  `specialist_result:<turnId>`. KV index maps trigger -> continuation id.
- **Fake ctx** - `fakeExecutionContext`; `waitUntil(p)` pushes into an array
  the consumer awaits before returning. Direct fix for the Slack-silence bug.
- **Continuation** - persisted suspend-point (state + trigger) in DO storage;
  authoritative record so a mid-turn redeploy resumes correctly.
- **Ingress vs Consumer** - ingress = `fetch` (verify, dedup, enqueue, ACK);
  consumer = `queue` (run or resume the turn under fake ctx).
- **Conversation** - Slack thread / GitHub issue / etc. One DO per
  conversation serializes continuation writes (invariant [#5]).
- **Delivery** - terminal Slack/GitHub post-back via `CfDeliveryAdapter`.
