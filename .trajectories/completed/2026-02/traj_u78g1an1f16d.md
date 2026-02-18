# Trajectory: Fix preview workflow PR comment permission failure

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** February 18, 2026 at 12:51 PM
> **Completed:** February 18, 2026 at 12:51 PM

---

## Summary

Updated preview workflow permissions for PR comments and set comment step continue-on-error to avoid failing successful deploys.

**Approach:** Standard approach

---

## Key Decisions

### Grant issues/pull-requests write permissions and make comment step non-blocking
- **Chose:** Grant issues/pull-requests write permissions and make comment step non-blocking
- **Reasoning:** Preview deploy succeeded but job failed due 403 on issue comment; commenting should not block deploy.

---

## Chapters

### 1. Work
*Agent: default*

- Grant issues/pull-requests write permissions and make comment step non-blocking: Grant issues/pull-requests write permissions and make comment step non-blocking
