# Trajectory: Fix workspace websocket missing events (messages, reactions, threads, DMs)

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 08:03 PM
> **Completed:** February 18, 2026 at 08:08 PM

---

## Summary

Made realtime event fanout reliable by running message/thread/reaction/DM fanout and webhook queue sends in request background lifecycle (waitUntil), fixing dropped workspace-stream events.

**Approach:** Standard approach

---

## Key Decisions

### Use executionCtx.waitUntil for websocket fanout and queue sends on message/thread/reaction/DM writes
- **Chose:** Use executionCtx.waitUntil for websocket fanout and queue sends on message/thread/reaction/DM writes
- **Reasoning:** Cloudflare may terminate unresolved fire-and-forget promises at response end, causing dropped realtime events; waitUntil makes delivery lifecycle explicit and reliable

---

## Chapters

### 1. Work
*Agent: default*

- Use executionCtx.waitUntil for websocket fanout and queue sends on message/thread/reaction/DM writes: Use executionCtx.waitUntil for websocket fanout and queue sends on message/thread/reaction/DM writes
