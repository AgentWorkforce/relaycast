# Trajectory: Fix thread reply sender address propagation

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** October 11, 2026 at 06:36 PM
> **Completed:** October 11, 2026 at 06:37 PM

---

## Summary

Thread replies now persist the server-resolved sender address after metadata sanitization, expose it on reply and thread wire shapes, and pass addressed-send conformance coverage.

**Approach:** Standard approach

---

## Key Decisions

### Persist the thread sender address as server-owned metadata after sanitization
- **Chose:** Persist the thread sender address as server-owned metadata after sanitization
- **Reasoning:** This matches DM behavior, prevents caller spoofing, and lets existing delivery serialization expose agent_address without changing relay-agent.

---

## Chapters

### 1. Work
*Agent: default*

- Persist the thread sender address as server-owned metadata after sanitization: Persist the thread sender address as server-owned metadata after sanitization

---

## Artifacts

**Commits:** 3b584c99
**Files changed:** 6
