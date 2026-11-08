# Trajectory: Preserve realtime blocks for Relay issue1359

> **Status:** ✅ Completed
> **Task:** [1359](https://github.com/AgentWorkforce/relay/issues/1359)
> **Confidence:** 95%
> **Started:** November 7, 2026 at 05:33 PM
> **Completed:** November 7, 2026 at 05:33 PM

---

## Summary

Preserved realtime blocks for channel messages, updates, threads, DMs and group DMs. SDK521, shared types278, strict types, build and lint pass; independent companion review PASS; no release or production access.

**Approach:** Standard approach

---

## Key Decisions

### Repair both websocket schema parsing and node delivery transforms
- **Chose:** Repair both websocket schema parsing and node delivery transforms
- **Reasoning:** Both paths independently drop blocks. Preserve absent/null/empty payloads and nested DM precedence. Cross-repo built SDK -> Relay adapter -> public listener parity passes for49KB blocks against fixture REST readback.

---

## Chapters

### 1. Work
*Agent: default*

- Repair both websocket schema parsing and node delivery transforms: Repair both websocket schema parsing and node delivery transforms
