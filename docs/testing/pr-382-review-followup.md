# PR 382 review follow-up evidence

Tests run locally with Node 22.14.0 (the CI version). Commands use the installed
Vitest binary; npm uses `--userconfig /tmp/empty-npmrc` because the default user
configuration is an unreadable symlink in this environment.

## Teardown rejection regression

Command (from `packages/engine`):

```sh
../../node_modules/.bin/vitest run src/__tests__/backgroundTasks.test.ts src/__tests__/conformance/harness.test.ts
```

Red, before the teardown fix (actual output):

```text
AssertionError: expected false to be true // Object.is equality
AssertionError: promise resolved "undefined" instead of rejecting
AssertionError: SQLite remained open after a failed drain: expected true to be false // Object.is equality
 Test Files  2 failed (2)
      Tests  4 failed (4)
```

Green, with unchanged regression tests (actual output):

```text
 Test Files  2 passed (2)
      Tests  4 passed (4)
```

The regressions cover remaining and newly tracked work, an already-settled
rejection, and SQLite closure after startup-poll failure.

## Remaining regression and fault checks

All faults below were temporary and removed before the final suite run. A
faulted test is expected to fail; “after” means a diagnostic failure replaced a
hang, not that the injected fault passed. The outer Vitest watchdog was reduced
to 2500ms to demonstrate the old hang without waiting 5–20 seconds.

### Unrelated timer and replay cleanup

Ran `invocationReplay.test.ts -t 'unrelated 10ms'` first with the old replay
block copied unchanged into the helper, then with the new helper. The test
schedules an unrelated 10ms timer without entering a pending-claim retry.

Before (actual output):

```text
AssertionError: promise resolved "[ …(2) ]" instead of rejecting
 Test Files  1 failed (1)
      Tests  1 failed | 3 skipped (4)
```

After, the helper regression suite including this case, a missing provider
frame, cleanup failure, and frozen global timers (actual output):

```text
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

For cleanup, ran `agentLifecycle.test.ts -t 'waits for a durable release dispatch
outcome' --testTimeout=2500` with an injected assertion after retry entry and a
replay response that never settles. Used the original block for “before” and
the extracted helper for “after”.

Before (actual output):

```text
Error: Test timed out in 2500ms.
```

After (actual output; preserves both the original failure and cleanup failure):

```text
Error: injected assertion before replay settled
Error: concurrent invocation cleanup never arrived within 1000ms
```

The production retry remains a 10ms yield. Only its named internal function
boundary is extracted; the helper observes that boundary and gates its first
retry until the winning dispatch completes. No global timer interception or
fake clock is needed by either conformance test.

### Socket and A2A missing notifications

Temporarily removed `MockWebSocket.onCreate`'s resolve call in
`packages/sdk-typescript/src/__tests__/identity.test.ts`, and separately removed
`onTransportEntered?.()` in
`packages/engine/src/__tests__/conformance/a2aFederation.test.ts`. Ran the affected
test in each file with `--testTimeout=2500`.

Before, both tests (actual output):

```text
Error: Test timed out in 2500ms.
```

After, respectively (actual output):

```text
Error: agent node socket construction never arrived within 1000ms
Error: forward A2A RPC POST transport entry never arrived within 1000ms
```

### Python missing signals

Called `FakeConnection.wait_sent('node.register')` without sending a frame.
Before, an external `asyncio.wait_for(..., timeout=1.2)` watchdog was necessary
(actual output):

```text
Outer watchdog expired after 1.2s; wait_sent emitted no diagnostic: TimeoutError:
```

After, invoked the frame wait and the two event waits with no signal. Each uses
its own one-second bound (actual output):

```text
AssertionError: sent node.register frame never arrived within 1.0s
AssertionError: reconnect registration never arrived within 1.0s
AssertionError: shutdown handler completion never arrived within 1.0s
```

Normal `uv run pytest tests/test_node.py -q`, including three missing-signal
regressions (actual output):

```text
20 passed in 0.27s
```

### Presence mock replacement

Added three harness regressions for a prior mock, reset mock, and replacement
of an installed tracker. Each supplies a blocked presence promise and verifies
that SQLite stays open until it is released.

Before (actual output):

```text
AssertionError: close did not await the presence tracking implementation: expected true to be false // Object.is equality
 Test Files  1 failed (1)
      Tests  3 failed | 2 passed (5)
```

After, running the harness, node, and agent lifecycle suites (actual output):

```text
 Test Files  3 passed (3)
      Tests  79 passed (79)
```

### Date restoration after a rejected close

Temporarily added two tests to `actionHandlerLifecycle.test.ts`: freeze Date to
2000 and reject `stack.close()`, then assert that the next test sees real Date.
The injected close error deliberately fails the first test in both runs.

Before (actual output):

```text
AssertionError: fake Date leaked after close rejected: expected 2000 not to be 2000 // Object.is equality
      Tests  2 failed | 11 skipped (13)
```

After (actual output; the next-test Date assertion now passes):

```text
      Tests  1 failed | 1 passed | 11 skipped (13)
```

### Documentation paths

Checked every first-column table path in `timing-determinism.md` with
`pathlib.Path.is_file()` before and after adding the repository-root prefix.

```text
red: 60 table paths checked; 60 missing
green: 60 table paths checked; 0 missing
```

## Final local validation

Full monorepo checks, with `npm_config_userconfig=/tmp/empty-npmrc` and
`DO_NOT_TRACK=1`:

```sh
node_modules/.bin/turbo lint build test
```

Actual output:

```text
@relaycast/engine:test:  Test Files  75 passed (75)
@relaycast/engine:test:       Tests  843 passed (843)
 Tasks:    26 successful, 26 total
Cached:    23 cached, 26 total
```

Unchanged packages reused the preceding successful local runs. The TypeScript
SDK suite passed all 445 tests. The Python SDK also passed its full suite:

```text
226 passed in 2.98s
```

The first full run exposed that background webhook teardown legitimately takes
three seconds for retries. Background draining therefore has a ten-second
named bound, below the engine's twenty-second test/hook watchdog. Narrow
signal waits retain one-second bounds. A separate regression verifies the
background timeout diagnostic using a short injected deadline.
