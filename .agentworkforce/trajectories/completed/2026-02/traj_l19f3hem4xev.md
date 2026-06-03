# Trajectory: Normalize SDK parameter casing style

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 20, 2026 at 02:30 PM
> **Completed:** February 20, 2026 at 02:34 PM

---

## Summary

Normalized SDK request inputs to camelCase across channels/files/commands/billing while keeping snake_case aliases; updated tests and verified with sdk tests + tsc build

**Approach:** Standard approach

---

## Key Decisions

### Standardize SDK request inputs to camelCase while preserving snake_case aliases
- **Chose:** Standardize SDK request inputs to camelCase while preserving snake_case aliases
- **Reasoning:** JS/TS ergonomics should be consistent at call sites, but existing users rely on snake_case; normalize in SDK adapter layer and keep API payloads snake_case

---

## Chapters

### 1. Work
*Agent: default*

- Standardize SDK request inputs to camelCase while preserving snake_case aliases: Standardize SDK request inputs to camelCase while preserving snake_case aliases
