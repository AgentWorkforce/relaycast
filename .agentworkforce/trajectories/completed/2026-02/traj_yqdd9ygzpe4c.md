# Trajectory: Review and simplify CI actions for robust PR and production deployments

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** February 18, 2026 at 10:07 PM
> **Completed:** February 18, 2026 at 10:10 PM

---

## Summary

Simplified CI/CD by extracting shared Cloudflare deployment logic into composite actions, gating preview deploys to same-repo PRs, removing duplicate CI runs on main pushes, and adding workflow timeouts plus safer production deploy args.

**Approach:** Standard approach

---

## Key Decisions

### Extract duplicated deployment steps into composite GitHub actions
- **Chose:** Extract duplicated deployment steps into composite GitHub actions
- **Reasoning:** Preview and production workflows currently duplicate D1 migration and observer Pages setup logic, which risks drift and inconsistent behavior.

### Gate preview deployments to same-repository pull requests and remove duplicate PR CI job
- **Chose:** Gate preview deployments to same-repository pull requests and remove duplicate PR CI job
- **Reasoning:** Previews require deployment secrets and currently rerun the same lint/test suite already handled in the CI workflow, causing redundant runs and potential fork-secret failures.

### Fix deploy-worker production command to omit --env when targeting production
- **Chose:** Fix deploy-worker production command to omit --env when targeting production
- **Reasoning:** Passing --env with an empty value is brittle and can break wrangler argument parsing; explicit omission is safer and clearer.

### Run CI workflow only for pull requests and keep main validation inside deploy pipeline
- **Chose:** Run CI workflow only for pull requests and keep main validation inside deploy pipeline
- **Reasoning:** This removes duplicate test runs on main pushes while preserving release safety because deploy workflow still blocks on lint/test before staging and production deployment.

---

## Chapters

### 1. Work
*Agent: default*

- Extract duplicated deployment steps into composite GitHub actions: Extract duplicated deployment steps into composite GitHub actions
- Gate preview deployments to same-repository pull requests and remove duplicate PR CI job: Gate preview deployments to same-repository pull requests and remove duplicate PR CI job
- Fix deploy-worker production command to omit --env when targeting production: Fix deploy-worker production command to omit --env when targeting production
- Run CI workflow only for pull requests and keep main validation inside deploy pipeline: Run CI workflow only for pull requests and keep main validation inside deploy pipeline
