# Trajectory: Add Rust SDK publish workflow and document manual first-publish process

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 20, 2026 at 10:02 PM
> **Completed:** February 20, 2026 at 10:02 PM

---

## Summary

Added a dedicated Rust SDK publish workflow with tag/version guard, CI tests, workflow_dispatch dry-run, and crates.io OIDC auth action.

**Approach:** Standard approach

---

## Key Decisions

### Use separate publish-rust workflow with tag gate sdk-rust-v* and workflow_dispatch dry-run
- **Chose:** Use separate publish-rust workflow with tag gate sdk-rust-v* and workflow_dispatch dry-run
- **Reasoning:** Keeps Rust release lifecycle independent from npm publish automation and prevents accidental publish with explicit version-tag matching

---

## Chapters

### 1. Work
*Agent: default*

- Use separate publish-rust workflow with tag gate sdk-rust-v* and workflow_dispatch dry-run: Use separate publish-rust workflow with tag gate sdk-rust-v* and workflow_dispatch dry-run
