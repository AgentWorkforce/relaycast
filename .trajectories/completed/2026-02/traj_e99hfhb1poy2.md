# Trajectory: Make SDK camelCase consistent across inputs, outputs, and WS events

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 20, 2026 at 02:57 PM
> **Completed:** February 20, 2026 at 02:57 PM

---

## Summary

Implemented SDK-wide camelCase surface by adding request/response/WS casing translation, replacing leaked raw type imports with camelized aliases, removing snake_case input compatibility, updating tests, and validating with sdk test/build

**Approach:** Standard approach

---

## Key Decisions

### Centralize casing translation in SDK transport layer
- **Chose:** Centralize casing translation in SDK transport layer
- **Reasoning:** Applying conversion in HttpClient/WsClient guarantees consistent camelCase behavior across all endpoints/events and avoids per-method drift

### Introduce camelized SDK type aliases
- **Chose:** Introduce camelized SDK type aliases
- **Reasoning:** SDK should not leak snake_case API types; local aliases preserve compatibility with source schemas while exposing a clean JS-style surface

---

## Chapters

### 1. Work
*Agent: default*

- Centralize casing translation in SDK transport layer: Centralize casing translation in SDK transport layer
- Introduce camelized SDK type aliases: Introduce camelized SDK type aliases
