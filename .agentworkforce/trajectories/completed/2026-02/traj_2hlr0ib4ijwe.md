# Trajectory: Make all route event emissions reliable via runInBackground

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** February 18, 2026 at 08:14 PM
> **Completed:** February 18, 2026 at 08:17 PM

---

## Summary

Converted remaining route fanout and webhook queue side-effects to runInBackground so event delivery uses waitUntil across channel/command/inboundWebhook/file/agent/receipt paths.

**Approach:** Standard approach

---

## Key Decisions

### Apply runInBackground to all route-level event fanout and webhook queue sends
- **Chose:** Apply runInBackground to all route-level event fanout and webhook queue sends
- **Reasoning:** Ensures every realtime side-effect runs under waitUntil and is not dropped at response completion in Workers

---

## Chapters

### 1. Work
*Agent: default*

- Apply runInBackground to all route-level event fanout and webhook queue sends: Apply runInBackground to all route-level event fanout and webhook queue sends
