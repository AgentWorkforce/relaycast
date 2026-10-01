# Trajectory: Fix Rust registration Retry-After cooldown handling

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 10, 2026 at 04:43 PM
> **Completed:** September 10, 2026 at 04:43 PM

---

## Summary

Rust registration now honors bounded server Retry-After cooldowns, preserves the 60-second malformed-header fallback, and schedules retries from the same cached cooldown.

**Approach:** Standard approach

---

## Key Decisions

### Registration cooldowns use the parsed Retry-After value, capped at five minutes
- **Chose:** Registration cooldowns use the parsed Retry-After value, capped at five minutes
- **Reasoning:** The hosted gateway sends a short authoritative delay; keeping a cap prevents malformed or hostile headers from blocking an agent indefinitely, while absent or malformed values retain the fail-closed 60-second fallback.

### Retry scheduling consumes the active cached cooldown
- **Chose:** Retry scheduling consumes the active cached cooldown
- **Reasoning:** Using the cache as the source of truth prevents the fixed two-second retry sleep from producing local Blocked attempts before the server-directed cooldown expires.

---

## Chapters

### 1. Work
*Agent: default*

- Registration cooldowns use the parsed Retry-After value, capped at five minutes: Registration cooldowns use the parsed Retry-After value, capped at five minutes
- Retry scheduling consumes the active cached cooldown: Retry scheduling consumes the active cached cooldown
