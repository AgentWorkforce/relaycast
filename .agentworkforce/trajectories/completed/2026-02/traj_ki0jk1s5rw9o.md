# Trajectory: Fix observer preview Pages build by marking Next routes Edge runtime

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** February 18, 2026 at 09:49 PM
> **Completed:** February 18, 2026 at 09:52 PM

---

## Summary

Added runtime=edge exports to dashboard catch-all page and all API routes required by next-on-pages so observer preview build can target Cloudflare Pages.

**Approach:** Standard approach

---

## Key Decisions

### Mark all non-static dashboard routes as Edge runtime
- **Chose:** Mark all non-static dashboard routes as Edge runtime
- **Reasoning:** Cloudflare next-on-pages requires App Router dynamic routes to export runtime=edge; this unblocks Pages build conversion for observer previews.

---

## Chapters

### 1. Work
*Agent: default*

- Mark all non-static dashboard routes as Edge runtime: Mark all non-static dashboard routes as Edge runtime
