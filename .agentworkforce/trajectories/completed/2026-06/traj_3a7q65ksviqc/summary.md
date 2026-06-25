# Trajectory: Fix observer authoritative DM and filter gaps

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** June 25, 2026 at 10:32 AM
> **Completed:** June 25, 2026 at 10:41 AM

---

## Summary

Made observer DM gating fail closed with channel_type-backed message resources, tightened file/event filters, added SDK scope enums, updated OpenAPI responses, and verified engine/SDK/Rust/Swift tests.

**Approach:** Standard approach

---

## Key Decisions

### Make channel_type authoritative for observer message gating
- **Chose:** Make channel_type authoritative for observer message gating
- **Reasoning:** conversation_id is a derived join and can be absent for non-normal channel rows; treating channel_type != 0 as private before channel-level allow checks makes DM blocking fail closed across single-resource message, thread, and reaction paths.

---

## Chapters

### 1. Work
*Agent: default*

- Make channel_type authoritative for observer message gating: Make channel_type authoritative for observer message gating

---

## Artifacts

**Commits:** efa6971
**Files changed:** 12
