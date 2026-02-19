# Trajectory: Reduce Relaycast request log noise and add actionable structured fields

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 19, 2026 at 12:46 PM
> **Completed:** February 19, 2026 at 12:57 PM

---

## Summary

Reduced noisy request warnings and added structured request failure metadata with tests

**Approach:** Standard approach

---

## Key Decisions

### Classified /v1/ws 401 and /mcp 400/406 as expected client noise with suppression + 2% sampling
- **Chose:** Classified /v1/ws 401 and /mcp 400/406 as expected client noise with suppression + 2% sampling
- **Reasoning:** These high-volume client misuse errors are expected and were obscuring actionable warnings

---

## Chapters

### 1. Work
*Agent: default*

- Classified /v1/ws 401 and /mcp 400/406 as expected client noise with suppression + 2% sampling: Classified /v1/ws 401 and /mcp 400/406 as expected client noise with suppression + 2% sampling
