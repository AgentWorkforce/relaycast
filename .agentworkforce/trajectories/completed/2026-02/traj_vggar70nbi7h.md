# Trajectory: Fix WS open-listener race causing e2e connect hang

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** February 18, 2026 at 05:33 PM
> **Completed:** February 18, 2026 at 05:35 PM

---

## Summary

Patched sdk websocket open-listener behavior and e2e connect wait logic; added regression tests

**Approach:** Standard approach

---

## Key Decisions

### Fixed WsClient late-listener open event race
- **Chose:** Fixed WsClient late-listener open event race
- **Reasoning:** e2e registered on.connected after connect; fast handshakes could miss open and hang indefinitely

### Added explicit websocket connect timeout/error handling in e2e script
- **Chose:** Added explicit websocket connect timeout/error handling in e2e script
- **Reasoning:** surface real connection failures quickly instead of hanging at Connect WebSockets

---

## Chapters

### 1. Work
*Agent: default*

- Fixed WsClient late-listener open event race: Fixed WsClient late-listener open event race
- Added explicit websocket connect timeout/error handling in e2e script: Added explicit websocket connect timeout/error handling in e2e script
