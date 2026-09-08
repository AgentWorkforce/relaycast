# Trajectory: Fail closed SDK bootstrap secret routing for non-HTTP base URLs

> **Status:** ✅ Completed
> **Task:** PR #393 repair
> **Confidence:** 92%
> **Started:** September 8, 2026 at 10:44 PM
> **Completed:** September 8, 2026 at 10:45 PM

---

## Summary

Rejected non-HTTP(S) anonymous bootstrap base URLs before fetch and added ftp/custom-scheme no-network regression coverage; focused SDK, release, build, lint, and container checks passed.

**Approach:** Standard approach

---

## Key Decisions

### Restricted anonymous bootstrap secret routing to HTTP(S) URLs
- **Chose:** Restricted anonymous bootstrap secret routing to HTTP(S) URLs
- **Reasoning:** A parseable non-hosted URL such as ftp:// reached fetch with the deployment secret; only HTTP(S) may be an explicit self-host API origin.

---

## Chapters

### 1. Work
*Agent: default*

- Restricted anonymous bootstrap secret routing to HTTP(S) URLs: Restricted anonymous bootstrap secret routing to HTTP(S) URLs
