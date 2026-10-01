# Trajectory: Restore immutable Relaycast migration 0045 after 8.6.0 release regression

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 9, 2026 at 07:16 AM
> **Completed:** September 9, 2026 at 07:58 AM

---

## Summary

Restored migration 0045 canonical bytes and added stable/prerelease published-migration immutability gates

**Approach:** Standard approach

---

## Key Decisions

### Restore migration 0045 to the 8.5.5 canonical bytes and gate releases against npm latest
- **Chose:** Restore migration 0045 to the 8.5.5 canonical bytes and gate releases against npm latest
- **Reasoning:** Mutating relaycast-cloud's applied migration or weakening byte-parity would hide the release regression. The release gate allows only the exact 8.6.0 bad-hash to canonical-hash recovery, then compares every published SQL migration on future releases.

### Protect every active npm release stream, not only latest
- **Chose:** Protect every active npm release stream, not only latest
- **Reasoning:** Published prerelease migrations may already be applied by users; checking the deduplicated latest/next/beta/alpha tag heads prevents later prerelease or stable releases from rewriting them while keeping registry cost bounded.

---

## Chapters

### 1. Work
*Agent: default*

- Restore migration 0045 to the 8.5.5 canonical bytes and gate releases against npm latest: Restore migration 0045 to the 8.5.5 canonical bytes and gate releases against npm latest
- Restored the canonical published migration bytes and added a release-time registry comparison with an exact 8.6.0 recovery exception. Full Node 22 suite, release contracts, build, lint, and the live npm comparison are green.
- Protect every active npm release stream, not only latest: Protect every active npm release stream, not only latest

---

## Artifacts

**Commits:** 5bb83371
**Files changed:** 9
