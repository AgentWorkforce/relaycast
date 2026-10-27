# Trajectory: Migrate remaining server request-body validation to Zod schemas

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 20, 2026 at 03:31 PM
> **Completed:** February 20, 2026 at 03:31 PM

---

## Summary

Migrated all server route JSON request parsing to Zod safeParse, preserved existing error semantics where possible, and validated with successful server build and test suite

**Approach:** Standard approach

---

## Key Decisions

### Standardize all server JSON body parsing on safeParse
- **Chose:** Standardize all server JSON body parsing on safeParse
- **Reasoning:** Single validation mechanism improves contract consistency and prevents drift between manual checks across routes

### Allow nullable update fields where routes already accepted null at runtime
- **Chose:** Allow nullable update fields where routes already accepted null at runtime
- **Reasoning:** Updated engine input types for workspace.system_prompt, channel.topic, and agent.persona to match existing runtime behavior while keeping new schemas type-safe

---

## Chapters

### 1. Work
*Agent: default*

- Standardize all server JSON body parsing on safeParse: Standardize all server JSON body parsing on safeParse
- Allow nullable update fields where routes already accepted null at runtime: Allow nullable update fields where routes already accepted null at runtime
