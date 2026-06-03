# Trajectory: Remove legacy docs/TELEMETRY.md pointer and add concrete telemetry implementation plan

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 19, 2026 at 05:09 PM
> **Completed:** February 19, 2026 at 05:10 PM

---

## Summary

Removed docs/TELEMETRY.md and expanded root TELEMETRY.md with a phased implementation plan (schema guards, MCP/CLI hardening, server events, SDK lifecycle telemetry, dashboard rollout).

**Approach:** Standard approach

---

## Key Decisions

### Delete docs/TELEMETRY.md and keep root TELEMETRY.md as sole source-of-truth
- **Chose:** Delete docs/TELEMETRY.md and keep root TELEMETRY.md as sole source-of-truth
- **Reasoning:** Removes duplicate docs surface and avoids spec drift while README already points to root file

### Add phased telemetry implementation plan directly in TELEMETRY.md
- **Chose:** Add phased telemetry implementation plan directly in TELEMETRY.md
- **Reasoning:** Keeps event taxonomy and rollout steps together so implementation can proceed without cross-referencing separate planning docs

---

## Chapters

### 1. Work
*Agent: default*

- Delete docs/TELEMETRY.md and keep root TELEMETRY.md as sole source-of-truth: Delete docs/TELEMETRY.md and keep root TELEMETRY.md as sole source-of-truth
- Add phased telemetry implementation plan directly in TELEMETRY.md: Add phased telemetry implementation plan directly in TELEMETRY.md
