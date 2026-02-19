# Trajectory: Add why-comment to background.ts helper

> **Status:** ✅ Completed
> **Confidence:** 99%
> **Started:** February 18, 2026 at 08:10 PM
> **Completed:** February 18, 2026 at 08:10 PM

---

## Summary

Added explicit why-comment to runInBackground describing dropped fire-and-forget promises in Workers and why waitUntil is required.

**Approach:** Standard approach

---

## Key Decisions

### Document why runInBackground exists
- **Chose:** Document why runInBackground exists
- **Reasoning:** Make Cloudflare lifecycle behavior explicit so future contributors don’t regress to fire-and-forget fanout

---

## Chapters

### 1. Work
*Agent: default*

- Document why runInBackground exists: Document why runInBackground exists
