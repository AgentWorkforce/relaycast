# Trajectory: Render raw JSON inbound webhook bodies

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** October 18, 2026 at 11:38 AM
> **Completed:** October 18, 2026 at 11:40 AM

---

## Summary

Rendered raw JSON inbound webhook bodies as message text when no envelope fields are present, with API test and docs.

**Approach:** Standard approach

---

## Key Decisions

### Use raw body as payload when no webhook envelope fields are present
- **Chose:** Use raw body as payload when no webhook envelope fields are present
- **Reasoning:** Preserves existing text/message/source/author behavior and makes third-party JSON bodies visible in the delivered message.

---

## Chapters

### 1. Work
*Agent: default*

- Use raw body as payload when no webhook envelope fields are present: Use raw body as payload when no webhook envelope fields are present
