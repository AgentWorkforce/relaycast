# Timing-test audit — 2026-09-07

Publish run [34115138538, attempt 1](https://github.com/AgentWorkforce/relaycast/actions/runs/34115138538/attempts/1) failed in **Build & Version → Run tests**. Its log records the MCP retry test timing out at 5043ms. The closed-database errors are **separate engine-test teardown races**, specifically `node.event_queue / retention_prune` in `conformance/node.test.ts`, not MCP errors.

The MCP test mocked the SDK but left registration's workspace-name `fetch` live. It now stubs that HTTP boundary, awaits the tool response (which completes `setSession`), and checks both the second WS factory call and the retry bridge's `connect` counter. All servers opened by this suite are closed after each test. No timeout was increased and no production code is changed.

**Lifecycle finding:** `runtime.close()` is synchronous, and a second `DurableEventQueue.poll()` call returns early while the first is busy. It therefore cannot be used to drain startup retention work. The harness captures the original poll promise; production shutdown behavior is unchanged.

The engine harness observes existing request `waitUntil`, startup/poll, node-drain, and detached presence-context promises. `settle()` waits for those promises, including work they enqueue. It never starts a replacement dispatch or advances real time. Cleanup drains them before closing SQLite. Tests of deliberately blocked work use narrower entry/completion signals and release their gates in `finally`.

## Survey

Searching this checkout's original tests for `setTimeout`, `sleep(`, and `advanceTimersByTime` found **28 files**, including a Rust match in comments. The release-blocking MCP file had no explicit timer: the default watchdog exposed its live HTTP dependency.

| File(s) | Former timing dependency | Replacement / triage |
| --- | --- | --- |
| MCP `server.test.ts` | Live workspace-name HTTP request under Vitest's 5s watchdog | Stub HTTP; await tool response; assert retry factory and connect calls |
| Engine `delivery.test.ts` | 5–1100ms sleeps and 1s assertion polling | Await request/dispatch completion; set stored expiry explicitly (SQLite TTLs are whole seconds) |
| Engine `node.test.ts` | Fanout sleeps, bounded polling, 1100ms presence expiry, 25ms replay wait | Await background/node-drain promises; controlled Date for presence; observe replay retry scheduling under fake timers |
| Engine `agentLifecycle.test.ts` | 25ms wait to assume replay is pending | Observe the replay's 10ms retry scheduling with fake timers before releasing dispatch; compare final responses |
| Engine `actionHandlerLifecycle.test.ts` | 50ms fanout and 60ms TTL sleeps | Await background work; freeze Date at an exact second and advance 51ms across the 50ms grace period |
| Engine `nodeDeliveryContracts.test.ts` | 1s polling and 50ms duplicate-dispatch waits | Await background work; fetch-entry signal plus losing-sweep completion/duplicate-call signal; per-recipient delivery-commit signal while HTTP remains gated |
| Engine `httpPushEphemeralEvents.test.ts` | 1s polling | Await HTTP/presence-context completion, then assert POST payloads |
| Engine `nodeProviders.test.ts` | 50 × 10ms polling for frames | Await request fanout or detached presence-context completion |
| Engine `rescheduleNodeProvider.test.ts` | 50 × 10ms polling | Await the actual serialized node drain |
| Engine `inboundWebhookTriggers.test.ts` | 50 × 10ms action polling and 50ms negative window | Await webhook/trigger background completion, then assert presence or absence |
| Engine `observerToken.test.ts`, `sdk-contract.test.ts`, `workspaceEvents.test.ts` | 50ms fanout sleeps | Await background publication and query/assert the actual frames or log rows |
| Engine `workspaceLifecycle.test.ts` | Zero-delay yield before negative reap assertion | Await request background completion |
| Engine `providerAttachDecision.test.ts` | Zero-delay teardown yield | Await harness close, including node drain and startup poll |
| Engine adapter `event-queue.test.ts` | 5s database polling | Capture and await the original poll promise, including startup; assert row deletion and fetch count |
| Engine routes `webhookOutbox.test.ts` | 25ms background-send sleeps | Bind Hono waitUntil and await queue handoff completion before inspecting persisted rows |
| Engine `a2aFederation.test.ts` | 75ms injected latency plus elapsed-time assertion | Explicit transport gate and entry signal; verify acceptance before delivery and revocation after completion |
| TypeScript SDK `identity.test.ts` | Up to 50 × 5ms waiting for a socket | Resolve a promise when the node WebSocket is constructed; disconnect in finally |
| Python SDK `test_node.py` | 1s polling of captured frames/handler state | asyncio.Event on socket sends, registration resolution, and handler shutdown completion |
| TypeScript SDK `agent-ws`, `client-retry`, `node-provider`, `relay`, `setup`, `ws` tests | Timer advancement | **Retained:** already use fake timers to drive production clocks deterministically |
| MCP `telemetry.test.ts`; Python `test_client.py`; Rust `client_retry.rs` | Stubbed timer/sleep methods; comment matches | **Retained:** fake transports/sleep recorders, retry counters; no elapsed-time success assertion |

Suite watchdogs and Python's existing waits on task/connection completion remain deadlock guards. Their values are not correctness assertions. No test sleeps or real-time polling loops remain in the surveyed test bodies.

## Red-then-green evidence

Faults below were injected temporarily into the named production behavior (the teardown fault targets the test harness). Each source was restored before green validation. The table records actual assertion failures, not hypothetical failures or failures inferred from runner timing. Unrelated failures/timeouts from broad exploratory mutant runs are not counted. No mutation is committed.

| Fault ID | Injected fault |
| --- | --- |
| `transport` | Node adapter sendToProvider returns false (drops delivery/context frames). |
| `authorized` | Node adapter sendAuthorizedActionToProvider returns false (drops action dispatch). |
| `stream` | publishToWorkspaceStream returns without publishing. |
| `log` | appendWorkspaceEvent returns null without inserting the event. |
| `queue` | completeEvent returns without deleting the delivered outbox row. |
| `outbox` | sendWebhookEvent returns before persisting or handing off the event. |
| `replay` | waitForInvocationReplayOutcome returns the pending claim immediately. |
| `depth` | Mailbox depth calculation counts expired rows by removing its expires_at predicate. |
| `ackexpiry2` | Expiry selects acked rows and removes the acked exclusion from the guarded update. |
| `generated` | isActionGeneratedMessage always returns false. |
| `claim` | HTTP dispatch claims by delivery ID without the nextAttemptAt compare-and-swap. |
| `reap` | Workspace creation schedules reaping even when result.created is false. |
| `retention` | Runtime config always uses the local retention default, ignoring the explicit boundary. |
| `a2a` | A2A translation replaces incoming message metadata with an empty object. |
| `slow` | markDeliveriesDelivered returns 0 without committing recipient delivery status. |
| `mcp` | Workspace switching does not clear wsInitAttempted. |
| `identity` | applyAgentRelayIdentityQuery returns without adding identity query parameters. |
| `teardown` | Test harness closes SQLite without awaiting its observed startup poll. |

### All 60 directly edited TypeScript test bodies

| Test file | Test | Fault | Actual red output (first line) |
| --- | --- | --- | --- |
| `engine/src/__tests__/conformance/a2aFederation.test.ts` | applies signed revocations in the authenticated reverse direction after transport completes | `a2a` | AssertionError: expected undefined to be defined |
| `engine/src/__tests__/conformance/actionHandlerLifecycle.test.ts` | re-registering under a fresh handler identity heals the handler pointer | `authorized` | AssertionError: expected 503 to be 201 // Object.is equality |
| `engine/src/__tests__/conformance/actionHandlerLifecycle.test.ts` | an invocation stuck on an unreachable handler is failed after the TTL and the caller is told | `authorized` | AssertionError: expected 503 to be 201 // Object.is equality |
| `engine/src/__tests__/conformance/actionHandlerLifecycle.test.ts` | deleting an action before provider acceptance fails its invocation and notifies the caller | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/actionHandlerLifecycle.test.ts` | the TTL clock starts at the first unreachable observation, not invocation age | `authorized` | AssertionError: expected 503 to be 201 // Object.is equality |
| `engine/src/__tests__/conformance/agentLifecycle.test.ts` | waits for a durable release dispatch outcome before answering a concurrent replay | `replay` | Error: Replay answered before dispatch completed |
| `engine/src/__tests__/conformance/delivery.test.ts` | routes via-node deliveries over the node control connection and cumulative ack marks them read | `transport` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/delivery.test.ts` | does not redeliver acked messages after a node reconnect with inventory sync | `transport` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/delivery.test.ts` | redelivers a channel message with the same deliver payload after broker death/reconnect | `transport` | AssertionError: expected undefined to be defined |
| `engine/src/__tests__/conformance/delivery.test.ts` | redelivers a DM with the same deliver payload after broker death/reconnect | `transport` | AssertionError: expected undefined to be defined |
| `engine/src/__tests__/conformance/delivery.test.ts` | redelivers a group DM with the same deliver payload after broker death/reconnect | `transport` | AssertionError: expected undefined to be defined |
| `engine/src/__tests__/conformance/delivery.test.ts` | redelivers a thread reply with the same deliver payload after broker death/reconnect | `transport` | AssertionError: expected undefined to be defined |
| `engine/src/__tests__/conformance/delivery.test.ts` | handles out-of-order cumulative acks idempotently | `transport` | AssertionError: expected [] to deeply equal [ 1, 2 ] |
| `engine/src/__tests__/conformance/delivery.test.ts` | does not skip a lower-seq queued delivery on node replay after an out-of-order per-delivery ack | `transport` | AssertionError: expected [] to deeply equal [ 1, 2 ] |
| `engine/src/__tests__/conformance/delivery.test.ts` | excludes expired (unswept) rows from the mailbox depth cap | `depth` | AssertionError: expected [ { v: 1, …(6) } ] to have a length of +0 but got 1 |
| `engine/src/__tests__/conformance/delivery.test.ts` | does not dead-letter an acked delivery after TTL expiry | `ackexpiry2` | AssertionError: expected [ { …(10) } ] to have a length of +0 but got 1 |
| `engine/src/__tests__/conformance/delivery.test.ts` | expires TTL deliveries to dead-letter and notifies the sender | `transport` | AssertionError: expected [] to deeply equal ArrayContaining{…} |
| `engine/src/__tests__/conformance/delivery.test.ts` | scheduled expiry drains a large backlog in D1-safe batches without affecting reads | `transport` | AssertionError: expected [] to have a length of 121 but got +0 |
| `engine/src/__tests__/conformance/delivery.test.ts` | rejects new deliveries over the depth cap and sends feedback to the sender | `transport` | AssertionError: expected [] to deeply equal ArrayContaining{…} |
| `engine/src/__tests__/conformance/inboundWebhookTriggers.test.ts` | does not re-fire a trigger for an action-generated webhook message | `generated` | AssertionError: expected [ { v: 1, …(4) } ] to have a length of +0 but got 1 |
| `engine/src/__tests__/conformance/node.test.ts` | emits agent.status.active on connect and agent.status.offline on sweep | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/node.test.ts` | delivers message.created to joined channel members through the node route | `transport` | AssertionError: expected [] to deeply equal [ ObjectContaining{…} ] |
| `engine/src/__tests__/conformance/node.test.ts` | creates a mention delivery for muted channel members when explicitly mentioned | `transport` | AssertionError: expected [] to deeply equal [ ObjectContaining{…} ] |
| `engine/src/__tests__/conformance/node.test.ts` | creates a mention delivery for muted members mentioned in thread replies | `transport` | AssertionError: expected [] to deeply equal [ ObjectContaining{…} ] |
| `engine/src/__tests__/conformance/node.test.ts` | replays queued direct-node deliveries when the agent socket reconnects | `transport` | AssertionError: expected [] to deeply equal [ ObjectContaining{…} ] |
| `engine/src/__tests__/conformance/node.test.ts` | registers a node, dispatches spawn, completes from action.result, fires triggers, and reschedules on node death | `authorized` | AssertionError: expected null to be 'ok' // Object.is equality |
| `engine/src/__tests__/conformance/node.test.ts` | drains an offline-queued invoke into dispatched state so the timeout sweep reschedules it | `authorized` | AssertionError: expected undefined to match object { …(2) } |
| `engine/src/__tests__/conformance/node.test.ts` | drains a queued spawn once the node registers without delaying the register-time drain | `transport` | AssertionError: expected { id: 'inv_222679985734631424', …(24) } to match object { status: 'pending', …(1) } |
| `engine/src/__tests__/conformance/node.test.ts` | waits for durable spawn dispatch state before answering a concurrent replay | `replay` | Error: Replay answered before dispatch completed |
| `engine/src/__tests__/conformance/node.test.ts` | fires a trigger only once when concurrent posts match the same rate-limited trigger | `authorized` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/node.test.ts` | publishes action.invoked to the workspace observer stream | `stream` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/nodeDeliveryContracts.test.ts` | claims a due http_push delivery only once across overlapping redrive sweeps | `claim` | AssertionError: expected "fetch" to be called 1 times, but got 2 times |
| `engine/src/__tests__/conformance/nodeDeliveryContracts.test.ts` | claims a never-attempted http_push delivery only once across overlapping sweeps | `claim` | AssertionError: expected "fetch" to be called 1 times, but got 2 times |
| `engine/src/__tests__/conformance/nodeDeliveryContracts.test.ts` | does not let a slow http_push receiver block self-connected recipients | `slow` | AssertionError: expected [ { …(29) } ] to deeply equal [ ObjectContaining{…} ] |
| `engine/src/__tests__/conformance/nodeProviders.test.ts` | routes deliver frames to the provider whose connection registered the agent | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/nodeProviders.test.ts` | rejects cross-provider action results and delivery acknowledgements | `transport` | TypeError: actual value must be number or bigint, received "undefined" |
| `engine/src/__tests__/conformance/nodeProviders.test.ts` | routes context.update to the provider hosting the agent, not a phantom node default | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/nodeProviders.test.ts` | posts a node-token message attributed to `from`, delivered to node-hosted recipients | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/observerToken.test.ts` | requires stream-scoped observer tokens for workspace WebSockets and filters events per socket | `stream` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/observerToken.test.ts` | allows DM stream events when channel filters are present and include_dms is enabled | `stream` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/rescheduleNodeProvider.test.ts` | queues on an offline owning provider only when the action opts in | `authorized` | AssertionError: expected +0 to be 1 // Object.is equality |
| `engine/src/__tests__/conformance/rescheduleNodeProvider.test.ts` | waits for handlers_live before draining an opted-in provider queue | `authorized` | AssertionError: expected +0 to be 1 // Object.is equality |
| `engine/src/__tests__/conformance/sdk-contract.test.ts` | filters actions by available_to, enforces invoke access, and emits action events | `transport` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/sdk-contract.test.ts` | keeps harness session event envelope types canonical | `stream` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/sdk-contract.test.ts` | emits canonical message.reacted events for reactions | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/sdk-contract.test.ts` | emits canonical message.read events over node delivery frames | `transport` | AssertionError: expected 0 to be greater than or equal to 1 |
| `engine/src/__tests__/conformance/workspaceEvents.test.ts` | appends a log row for channel messages and stamps the assigned seq on the published frame | `log` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/workspaceEvents.test.ts` | serves cursor-based reads to workspace keys with ascending seq and latest_seq | `log` | AssertionError: expected 0 to be greater than or equal to 3 |
| `engine/src/__tests__/conformance/workspaceEvents.test.ts` | filters channel-bound rows for scoped observer tokens while rows without a channel pass | `log` | AssertionError: expected [] to have a length of 2 but got +0 |
| `engine/src/__tests__/conformance/workspaceEvents.test.ts` | pages past fully-filtered windows for scoped tokens via next_since | `log` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/__tests__/conformance/workspaceLifecycle.test.ts` | does not schedule a reap for an idempotent create hit | `reap` | AssertionError: expected [] to have a length of 1 but got +0 |
| `engine/src/adapters/node/__tests__/event-queue.test.ts` | send persists the outbox row before delivery completes | `queue` | AssertionError: expected [ { id: '222680357566193664', …(10) } ] to have a length of +0 but got 1 |
| `engine/src/adapters/node/__tests__/event-queue.test.ts` | send with a pre-inserted outbox row (outboxId) does not double-insert | `queue` | AssertionError: expected [ { id: '222680357918515200', …(10) } ] to have a length of +0 but got 1 |
| `engine/src/adapters/node/__tests__/event-queue.test.ts` | resumes pending deliveries after a restart over the same database | `queue` | AssertionError: expected [ { id: '222680383977725952', …(10) } ] to have a length of +0 but got 1 |
| `engine/src/adapters/node/__tests__/event-queue.test.ts` | preserves an explicit engine retention boundary over the local pruner default | `retention` | AssertionError: expected { messageTtlDays: 7 } to deeply equal { messageTtlDays: 45 } |
| `engine/src/routes/__tests__/webhookOutbox.test.ts` | inserts the outbox row before invoking eventQueue.send and passes its id | `outbox` | AssertionError: expected undefined to be defined |
| `engine/src/routes/__tests__/webhookOutbox.test.ts` | keeps the row sweepable when the queue send throws synchronously | `outbox` | TypeError: Cannot read properties of undefined (reading 'outboxId') |
| `engine/src/routes/__tests__/webhookOutbox.test.ts` | keeps the row sweepable when the queue send rejects asynchronously | `outbox` | AssertionError: expected false to be true // Object.is equality |
| `mcp/src/__tests__/server.test.ts` | retries WS bridge initialization after switching away from a token that failed WS init | `mcp` | AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times |
| `sdk-typescript/src/__tests__/identity.test.ts` | forwards identity onto an agent socket too, not just the observer socket | `identity` | AssertionError: expected null to be 'usr_abc123' // Object.is equality |

The added harness regression also fails with the `teardown` fault: `AssertionError: expected false to be true // Object.is equality`. Its green run verifies that SQLite stays open until startup completes and closes afterward.

### All 11 directly edited Python test bodies

`python-wire` corrupts handler results/errors, heartbeat active-agent count, spawn input, message sender, and context node name. `python-reconnect` exits the serve loop instead of reconnecting. `python-stop` omits graceful deregistration.

| Test | Fault | Actual red output |
| --- | --- | --- |
| `test_invoke_runs_handler_and_replies_with_output` | `python-wire` | AssertionError: assert {'invocation_...sult', 'v': 1} == {'invocation_...sult', 'v': 1} |
| `test_invoke_supports_a_sync_handler` | `python-wire` | AssertionError: assert None == {'echoed': {'rows': 2}} |
| `test_handler_throw_becomes_error_result_never_dropped` | `python-wire` | AssertionError: assert {'error': 'lo...sult', 'v': 1} == {'error': 'bo...sult', 'v': 1} |
| `test_unknown_action_errors_rather_than_dropping` | `python-wire` | AssertionError: assert 'nope' in 'Unknown action' |
| `test_finite_heartbeat_is_provider_scoped_without_placeholder_load_or_last_heartbeat_at` | `python-wire` | assert 1 == 0 |
| `test_reconnects_with_new_instance_id_after_unexpected_drop` | `python-reconnect` | TimeoutError |
| `test_reconnects_when_dropped_during_register_handshake` | `python-reconnect` | TimeoutError |
| `test_handler_can_call_stop_without_deadlocking` | `python-stop` | AssertionError: assert 0 == 1 |
| `test_spawn_agent_sends_capacity_direct_node_spawn_frame` | `python-wire` | AssertionError: assert {} == {'cli': 'clau...': 'worker-1'} |
| `test_send_message_posts_to_canonical_channel_route` | `python-wire` | AssertionError: assert {'from': 'wro...text': 'done'} == {'from': 'rep...text': 'done'} |
| `test_ctx_node_exposes_name_and_capability_names` | `python-wire` | AssertionError: assert 'wrong-node' == 'alpha' |

### Pasted run output

MCP retry-reset fault, followed by the restored server suite:

```text
FAIL src/__tests__/server.test.ts > createRelayMcpServer > retries WS bridge initialization after switching away from a token that failed WS init
AssertionError: expected "vi.fn()" to be called 2 times, but got 1 times
Tests  1 failed | 9 skipped (10)

Test Files  1 passed (1)
     Tests  10 passed (10)
```

The nine tests skipped by that targeted red command were **not run**, not passed. The subsequent full MCP run passed all 224 tests.

Final restored validation used Node 22.14.0. Installation used `npm --userconfig /tmp/empty-npmrc ci`; an untracked npm launcher supplied that same explicit userconfig to Turbo child commands because the local default npmrc is a blocking symlink. Node 26's native SQLite build failed locally, so validation used Node 22.

```text
turbo build
Tasks:    9 successful, 9 total
Cached:    0 cached, 9 total

turbo lint
Tasks:    13 successful, 13 total
Cached:    5 cached, 13 total

turbo test
Tasks:    18 successful, 18 total
Cached:    9 cached, 18 total
```

The cached tasks in `turbo test` were build dependencies. All nine test tasks executed. Package results: engine 828; MCP 224; TypeScript SDK 445; types 209; A2A 65; React 39; observer dashboard 18; OpenClaw 19; public relaycast 3. All passed; no tests skipped. The full output contains no closed-database or unhandled-error reports.

```text
uv run --project packages/sdk-python --extra dev pytest packages/sdk-python/tests -q
223 passed in 8.27s

node --test test/container-entrypoint.test.mjs
# tests 14
# pass 14
# fail 0
# skipped 0
```

The repository lint configuration excludes test files. Supplemental lint of the new harness and replay tests used the same TypeScript recommended rules without the production-only project service and passed. After final timer-spy cleanup, the two concurrent-replay tests were rerun successfully; 72 unrelated tests were excluded by that targeted filter, not re-counted as passes.

## CI and review state at PR creation

The failed publish attempt's jobs were checked individually: **Build & Version — failed; Publish ${{ matrix.package }} — SKIPPED; Summary — passed; Publish Single Package — SKIPPED; Create Release — SKIPPED.** Those skipped jobs are absent validation/publication, not success.

This branch's PR CI is **not run yet** at creation: **Lint, Build & Test; Container (linux/amd64); Container (linux/arm64); Rust SDK**. Local container-entrypoint tests do not stand in for the two image-build jobs. No Rust code changed, and no local Rust run is claimed.

A pre-open GraphQL query requested this branch's open PRs and `reviewThreads { isResolved }`; it returned no existing PRs. Review and PR-triggered job results will belong to the newly opened PR. This task stops when that PR is opened; it does not merge.
