# Trajectory: Fix WS activity channel labels and remove App tab from Activity

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** February 18, 2026 at 08:42 PM
> **Completed:** February 18, 2026 at 08:44 PM

---

## Summary

Fixed WS activity member channel labels and removed Activity App tab so panel is websocket-only.

**Approach:** Standard approach

---

## Key Decisions

### Use websocket-only Activity panel and fix member event channel label parsing
- **Chose:** Use websocket-only Activity panel and fix member event channel label parsing
- **Reasoning:** Observer dashboard now relies on workspace WS stream; member events expose channel in  field, so summaries must read that key

---

## Chapters

### 1. Work
*Agent: default*

- Use websocket-only Activity panel and fix member event channel label parsing: Use websocket-only Activity panel and fix member event channel label parsing
