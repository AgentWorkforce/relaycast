# Trajectory: Add callable preview environment audit/remove workflow

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 19, 2026 at 01:25 AM
> **Completed:** February 19, 2026 at 01:25 AM

---

## Summary

Added .github/workflows/preview-env-audit.yml as a callable/manual workflow to audit Cloudflare preview workers against open PRs and optionally delete stale workers

**Approach:** Standard approach

---

## Key Decisions

### Use workflow_dispatch + workflow_call for preview cleanup automation
- **Chose:** Use workflow_dispatch + workflow_call for preview cleanup automation
- **Reasoning:** This makes preview environment cleanup callable manually and from other workflows, with safe audit mode as default and explicit remove mode.

---

## Chapters

### 1. Work
*Agent: default*

- Use workflow_dispatch + workflow_call for preview cleanup automation: Use workflow_dispatch + workflow_call for preview cleanup automation
