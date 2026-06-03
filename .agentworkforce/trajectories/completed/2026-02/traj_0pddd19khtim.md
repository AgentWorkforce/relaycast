# Trajectory: Fix CI migration config paths to absolute workspace paths

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** February 18, 2026 at 05:04 PM
> **Completed:** February 18, 2026 at 05:05 PM

---

## Summary

Updated preview and deploy migration steps to use absolute workspace paths

**Approach:** Standard approach

---

## Key Decisions

### Root-caused preview migration failure to relative paths in temp wrangler config
- **Chose:** Root-caused preview migration failure to relative paths in temp wrangler config
- **Reasoning:** Config created in /tmp made migrations_dir resolve to /tmp/packages/... causing 'No migrations present'

### Switched migration config paths to absolute $GITHUB_WORKSPACE paths
- **Chose:** Switched migration config paths to absolute $GITHUB_WORKSPACE paths
- **Reasoning:** Ensures wrangler finds worker entry and migrations regardless of temp config location

---

## Chapters

### 1. Work
*Agent: default*

- Root-caused preview migration failure to relative paths in temp wrangler config: Root-caused preview migration failure to relative paths in temp wrangler config
- Switched migration config paths to absolute $GITHUB_WORKSPACE paths: Switched migration config paths to absolute $GITHUB_WORKSPACE paths
