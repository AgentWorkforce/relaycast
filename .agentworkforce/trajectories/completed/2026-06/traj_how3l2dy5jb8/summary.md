# Trajectory: Expose fleet node workspace flag in TypeScript SDK

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 18, 2026 at 01:04 PM
> **Completed:** June 18, 2026 at 01:10 PM

---

## Summary

Added Relaycast TypeScript SDK workspace.fleetNodes get/set/inherit helpers for the existing /v1/workspace/fleet-nodes endpoint, with tests and README docs. Kept package versions unchanged for the normal release process.

**Approach:** Standard approach

---

## Key Decisions

### Did not manually bump @relaycast/sdk version
- **Chose:** Did not manually bump @relaycast/sdk version
- **Reasoning:** Versioning follows the repo release process; kept Relaycast package and lockfile versions unchanged while adding SDK source/tests.

---

## Chapters

### 1. Work
*Agent: default*

- Did not manually bump @relaycast/sdk version: Did not manually bump @relaycast/sdk version
