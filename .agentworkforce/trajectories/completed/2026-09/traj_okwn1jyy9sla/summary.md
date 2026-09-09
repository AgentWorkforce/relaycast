# Trajectory: Fix Relaycast Docker lock release refresh

> **Status:** ✅ Completed
> **Task:** relaycast#397
> **Confidence:** 97%
> **Started:** September 9, 2026 at 06:26 AM
> **Completed:** September 9, 2026 at 06:35 AM

---

## Summary

Changed Relaycast release Docker lock refresh to targeted npm update and added regression contract coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use targeted npm update for the Docker engine lock
- **Chose:** Use targeted npm update for the Docker engine lock
- **Reasoning:** The release artifact pre-bumps the lock entry version, so generic npm install trusts the placeholder and retains the old resolved tarball. Targeted npm update re-resolves the published 8.6.0 artifact while preserving the exact package.json pin.

---

## Chapters

### 1. Work
*Agent: default*

- Use targeted npm update for the Docker engine lock: Use targeted npm update for the Docker engine lock
- Production failure reproduced from the exact build artifact; generic install stayed stale, targeted update refreshed version, URL, integrity, and internal dependency pins. Base contract red, head contract and full release suite green.
