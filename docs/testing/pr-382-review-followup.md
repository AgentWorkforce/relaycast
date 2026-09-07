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
