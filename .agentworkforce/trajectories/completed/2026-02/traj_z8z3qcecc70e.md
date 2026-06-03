# Trajectory: Harden e2e script for staging consistency and websocket reconnect timing

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 06:09 PM
> **Completed:** February 18, 2026 at 06:19 PM

---

## Summary

Fixed staging/preview WebSocket instability by normalizing SDK WS URLs (removing trailing-slash double-path bug), adding reconnect fallback for pre-open errors, and hardening e2e URL normalization. Added regression tests for both cases.

**Approach:** Standard approach

---

## Key Decisions

### Normalize WebSocket base URLs and reconnect on pre-open errors in SDK
- **Chose:** Normalize WebSocket base URLs and reconnect on pre-open errors in SDK
- **Reasoning:** Cloudflare treats //v1/ws as a distinct path (404), while local dev tolerated it; trailing-slash base URLs caused ws handshake failures and silent connect timeouts. Adding URL normalization and explicit reconnect fallback improves cross-environment reliability.

---

## Chapters

### 1. Work
*Agent: default*

- Normalize WebSocket base URLs and reconnect on pre-open errors in SDK: Normalize WebSocket base URLs and reconnect on pre-open errors in SDK
