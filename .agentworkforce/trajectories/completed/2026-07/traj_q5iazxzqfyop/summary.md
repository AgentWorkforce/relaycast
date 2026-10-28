# Trajectory: Implement Relaycast A2A team directory and shared card contract

> **Status:** ✅ Completed
> **Task:** 294
> **Confidence:** 95%
> **Started:** July 21, 2026 at 10:52 PM
> **Completed:** July 21, 2026 at 11:08 PM

---

## Summary

Published @relaycast/a2a package metadata/docs; added unified filterable A2A directory engine route, SDK method, OpenAPI/README/changelogs, unit tests, and booted-gateway discover-to-message E2E.

**Approach:** Standard approach

---

## Key Decisions

### Use relay identities as directory names and engagement URLs as url fields
- **Chose:** Use relay identities as directory names and engagement URLs as url fields
- **Reasoning:** The E2E must feed a discovered identity directly into A2A message/send, while native results must remain directly DM-addressable; registered proxy rows are excluded from the native half to avoid duplicates.

---

## Chapters

### 1. Work
*Agent: default*

- Use relay identities as directory names and engagement URLs as url fields: Use relay identities as directory names and engagement URLs as url fields
- Implementation, package contract, docs, unit coverage, SDK surface, and real-gateway discovery-to-engagement E2E are aligned and green.
