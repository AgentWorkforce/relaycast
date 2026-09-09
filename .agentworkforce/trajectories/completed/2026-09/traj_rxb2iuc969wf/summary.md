# Trajectory: Review and repair Relaycast PR #393 Cubic findings

> **Status:** ✅ Completed
> **Task:** relaycast#393
> **Confidence:** 90%
> **Started:** September 9, 2026 at 03:39 AM
> **Completed:** September 9, 2026 at 03:45 AM

---

## Summary

Repaired Relaycast PR #393 findings: exact dotted dist-tag lookup, ancestry-bound prior stable tags, an immutable changelog date read from the annotated release tag on retries, Workers-compatible manual rejection of anonymous bootstrap redirects, and historical non-gating attribution for two empty-evidence trajectories. The Node 22 release suite passed 70/70 and the SDK suite passed 457/457 through product commit 38eaa7078f15eb3f57e1d8a0da3c8a78e83f5ff4.

**Approach:** Standard approach

---

## Key Decisions

### Bind retry inputs to immutable registry, source, and tag objects
- **Chose:** Read the full npm dist-tag object, restrict prior tags to source ancestry, and recover the changelog date from the existing annotated tag.
- **Reasoning:** Dotted tag names are path-ambiguous in npm view; fetched future tags must not alter older release changelogs; a fresh workflow date changes across reruns, while the tag object preserves the exact original cut date. Cloudflare Workers reject `redirect: error`, so secret-bearing bootstrap requests use manual mode and reject redirect responses before parsing.

---

## Chapters

### 1. Work
*Agent: default*

- Bind retry inputs to immutable registry, source, and tag objects.
