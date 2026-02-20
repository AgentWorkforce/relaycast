# Trajectory: Remove packages/cli and all references

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** February 20, 2026 at 04:20 PM
> **Completed:** February 20, 2026 at 04:36 PM

---

## Summary

Deleted packages/cli and removed all repo references to the CLI package/binary across docs, telemetry docs, publish workflow, site examples, and OpenClaw skill/setup content. Regenerated lockfile and verified builds/tests.

**Approach:** Standard approach

---

## Key Decisions

### Removed CLI package and deleted all remaining CLI-package references
- **Chose:** Removed CLI package and deleted all remaining CLI-package references
- **Reasoning:** User requested complete removal to reduce confusion; keeping docs/workflows/OpenClaw examples pointing to relaycast CLI would leave dead paths.

---

## Chapters

### 1. Work
*Agent: default*

- Removed CLI package and deleted all remaining CLI-package references: Removed CLI package and deleted all remaining CLI-package references
