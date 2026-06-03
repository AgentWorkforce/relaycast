# Trajectory: Add stream toggle diagnostics for preview dashboard failures

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 10:39 PM
> **Completed:** February 18, 2026 at 10:40 PM

---

## Summary

Added detailed logging and error surfacing for workspace stream enable/get flows in dashboard and server routes, including upstream Relay error code/status/message, base URL resolution, and forwarded host context.

**Approach:** Standard approach

---

## Key Decisions

### Add structured stream toggle diagnostics across dashboard API and server routes
- **Chose:** Add structured stream toggle diagnostics across dashboard API and server routes
- **Reasoning:** Generic UI failures obscured upstream cause; include Relay error code/status/message, resolved base URL, and forwarded host context to isolate routing/version/binding regressions in preview quickly.

---

## Chapters

### 1. Work
*Agent: default*

- Add structured stream toggle diagnostics across dashboard API and server routes: Add structured stream toggle diagnostics across dashboard API and server routes
