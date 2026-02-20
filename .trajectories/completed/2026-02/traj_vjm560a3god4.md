# Trajectory: Add runtime API toggle for workspace stream

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 18, 2026 at 07:07 PM
> **Completed:** February 18, 2026 at 07:09 PM

---

## Summary

Implemented runtime workspace stream toggle API (GET/PUT /v1/workspace/stream) backed by KV override + cache, and wired worker/fanout/presence to honor per-workspace toggle.

**Approach:** Standard approach

---

## Key Decisions

### Add per-workspace runtime stream toggle via KV-backed API
- **Chose:** Add per-workspace runtime stream toggle via KV-backed API
- **Reasoning:** Environment-only flags are too coarse. A workspace-scoped toggle endpoint allows enabling observer websocket stream only when needed, keeping default production cost path unchanged.

---

## Chapters

### 1. Work
*Agent: default*

- Add per-workspace runtime stream toggle via KV-backed API: Add per-workspace runtime stream toggle via KV-backed API
