# Trajectory: Fix Relaycast package publish name

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** April 17, 2026 at 11:54 AM
> **Completed:** April 17, 2026 at 11:59 AM

---

## Summary

Aligned the CLI package with the unscoped relaycast npm name, updated docs/release metadata, regenerated the workspace lockfile link, normalized package repository URLs, and verified CLI tests plus npm dry-run publish.

**Approach:** Standard approach

---

## Key Decisions

### Publish CLI as unscoped relaycast package
- **Chose:** Publish CLI as unscoped relaycast package
- **Reasoning:** The npm failure targeted @relaycast/cli, while packages/cli/package.json and the intended public package name should be relaycast; updating the manifest, lockfile, docs, release notes, and CLI identity keeps npm publish and user-facing output aligned.

---

## Chapters

### 1. Work
*Agent: default*

- Publish CLI as unscoped relaycast package: Publish CLI as unscoped relaycast package
