# Trajectory: Ship @relaycast/engine as standalone bun-compiled binaries

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** October 26, 2026 at 01:19 AM
> **Completed:** October 26, 2026 at 01:19 AM

---

## Summary

Standalone relaycast-engine binaries for 7 targets via bun build --compile with a bun:sqlite driver seam; full engine suite passes on bun:sqlite; CI builds, smoke-tests natively, and attaches assets to releases

**Approach:** Standard approach

---

## Key Decisions

### Build-entry module swap (sqlite-driver, migration-source, version) via a Bun.build plugin instead of runtime driver detection
- **Chose:** Build-entry module swap (sqlite-driver, migration-source, version) via a Bun.build plugin instead of runtime driver detection
- **Reasoning:** Node path keeps static better-sqlite3 imports with zero behaviour change and no top-level await; the binary never bundles the native addon (build fails if it would); vitest under Bun aliases the same module so the full suite runs on bun:sqlite

### Wrap bun:sqlite in a better-sqlite3-compatible facade and route drizzle through it
- **Chose:** Wrap bun:sqlite in a better-sqlite3-compatible facade and route drizzle through it
- **Reasoning:** bun:sqlite swallows errors from non-final statements in exec, silently drops prepare tails, returns null from get, and counts FK/trigger rows in changes; the facade normalizes all of these so migrations and tests behave identically

### Use a lookup-pinned node:https transport for outbound webhooks under Bun
- **Chose:** Use a lookup-pinned node:https transport for outbound webhooks under Bun
- **Reasoning:** Bun's undici shim ignores dispatcher, which silently disabled connect-time DNS pinning (SSRF guard); Bun honours lookup on node:https, verified by positive control and a mutation-checked regression test

---

## Chapters

### 1. Work
*Agent: default*

- Build-entry module swap (sqlite-driver, migration-source, version) via a Bun.build plugin instead of runtime driver detection: Build-entry module swap (sqlite-driver, migration-source, version) via a Bun.build plugin instead of runtime driver detection
- Wrap bun:sqlite in a better-sqlite3-compatible facade and route drizzle through it: Wrap bun:sqlite in a better-sqlite3-compatible facade and route drizzle through it
- Use a lookup-pinned node:https transport for outbound webhooks under Bun: Use a lookup-pinned node:https transport for outbound webhooks under Bun
