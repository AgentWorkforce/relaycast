# Trajectory: Review and repair Relaycast PR #393 Cubic findings

> **Status:** ✅ Completed
> **Task:** relaycast#393
> **Confidence:** 90%
> **Started:** September 9, 2026 at 03:39 AM
> **Completed:** September 9, 2026 at 03:45 AM

---

## Summary

Repaired Relaycast PR #393 findings: exact dotted dist-tag lookup, ancestry-bound prior stable tags, an immutable changelog date read from the annotated release tag on retries, and historical non-gating attribution for two empty-evidence trajectories. The 70-test release suite and syntax/diff checks passed at product commit 1a46c2ecaff0d17f2a036309ac9c43c60115b665.

**Approach:** Standard approach

---

## Key Decisions

### Bind retry inputs to immutable registry, source, and tag objects
- **Chose:** Read the full npm dist-tag object, restrict prior tags to source ancestry, and recover the changelog date from the existing annotated tag.
- **Reasoning:** Dotted tag names are path-ambiguous in npm view; fetched future tags must not alter older release changelogs; a fresh workflow date changes across reruns, while the tag object preserves the exact original cut date. Cloudflare redirect manual handling was already correct.

---

## Chapters

### 1. Work
*Agent: default*

- Bind retry inputs to immutable registry, source, and tag objects.
