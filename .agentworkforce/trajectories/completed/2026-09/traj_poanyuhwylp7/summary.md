# Trajectory: Fail closed when published Relaycast migrations are absent

> **Status:** ✅ Completed
> **Task:** relaycast#400
> **Confidence:** 96%
> **Started:** September 9, 2026 at 08:09 AM
> **Completed:** September 9, 2026 at 08:09 AM

---

## Summary

Made the published-engine migration release gate fail closed on absent migration directories and added a regression test; focused, release-contract, and live registry stream checks passed.

**Approach:** Standard approach

---

## Key Decisions

### Treat a missing published migrations directory as malformed
- **Chose:** Treat a missing published migrations directory as malformed
- **Reasoning:** Interpreting it as an empty baseline would allow a release to remove all published migration history without detection.

---

## Chapters

### 1. Work
*Agent: default*

- Treat a missing published migrations directory as malformed: Treat a missing published migrations directory as malformed
