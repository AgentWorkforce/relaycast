# Trajectory: Fix CI test failures after snake_case to camelCase normalization

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 20, 2026 at 07:04 PM
> **Completed:** February 20, 2026 at 07:06 PM

---

## Summary

Fixed CI test failures by upgrading sdk Vitest, adding required root dev deps for Vitest v3 packages, and updating mcp/react tests to current camelCase contracts; full turbo test now passes.

**Approach:** Standard approach

---

## Key Decisions

### Pinned missing Vitest transitive deps at repo root
- **Chose:** Pinned missing Vitest transitive deps at repo root
- **Reasoning:** CI lockfile state omitted loupe and related packages required by Vitest v3 in openclaw/react, causing ERR_MODULE_NOT_FOUND in GitHub Actions despite local partial cache hits.

### Normalized test fixtures/assertions to camelCase internal SDK contracts
- **Chose:** Normalized test fixtures/assertions to camelCase internal SDK contracts
- **Reasoning:** Runtime contracts were migrated to camelCase but several mcp/react tests still asserted snake_case internal payloads, producing false failures.

---

## Chapters

### 1. Work
*Agent: default*

- Pinned missing Vitest transitive deps at repo root: Pinned missing Vitest transitive deps at repo root
- Normalized test fixtures/assertions to camelCase internal SDK contracts: Normalized test fixtures/assertions to camelCase internal SDK contracts
