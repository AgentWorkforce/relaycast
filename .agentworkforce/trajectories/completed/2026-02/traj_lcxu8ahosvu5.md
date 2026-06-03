# Trajectory: Enforce snake_case-only channel invite input: agent_name

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 20, 2026 at 03:18 PM
> **Completed:** February 20, 2026 at 03:21 PM

---

## Summary

Switched channel invite and group DM participant input to snake_case-only agent_name, replaced manual checks with Zod validation in key DM/channel routes, and synchronized OpenAPI/tests

**Approach:** Standard approach

---

## Key Decisions

### Use Zod schemas for channel invite and group DM participant input validation
- **Chose:** Use Zod schemas for channel invite and group DM participant input validation
- **Reasoning:** Schema-based validation enforces snake_case contracts and reduces ad-hoc manual checks that can drift

---

## Chapters

### 1. Work
*Agent: default*

- Use Zod schemas for channel invite and group DM participant input validation: Use Zod schemas for channel invite and group DM participant input validation
