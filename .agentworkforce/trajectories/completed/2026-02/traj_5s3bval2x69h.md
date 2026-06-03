# Trajectory: Disable D1 migrations in PR preview deployments

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 18, 2026 at 10:14 PM
> **Completed:** February 18, 2026 at 10:15 PM

---

## Summary

Updated preview workflow to stop applying D1 migrations in PR environments; migrations now remain in the main deploy workflow for staging and production only.

**Approach:** Standard approach

---

## Key Decisions

### Disable D1 migrations in preview workflow
- **Chose:** Disable D1 migrations in preview workflow
- **Reasoning:** Preview deployments share staging database, so PR-triggered migrations risk unintended schema changes across active pull requests.

---

## Chapters

### 1. Work
*Agent: default*

- Disable D1 migrations in preview workflow: Disable D1 migrations in preview workflow
