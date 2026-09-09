# Trajectory: Repair Relaycast release tag Docker lock provenance validation

> **Status:** ✅ Completed
> **Task:** relaycast#393
> **Confidence:** 96%
> **Started:** September 9, 2026 at 01:53 AM
> **Completed:** September 9, 2026 at 02:09 AM

---

## Summary

Bound reusable release-tag Docker lock validation to the immutable release provenance manifest, requiring exact a2a, types, and engine package integrities and adding real registry-backed retry/adversarial coverage.

**Approach:** Standard approach

---

## Key Decisions

### Bind Docker lock reuse to the full release provenance manifest
- **Chose:** Bind Docker lock reuse to the full release provenance manifest
- **Reasoning:** A valid SHA-512 shape does not identify the published bytes. The workflow artifact already binds package integrities to the immutable source and annotated digest, so the validator derives exact a2a, types, and engine values from that manifest.

---

## Chapters

### 1. Work
*Agent: default*

- Bind Docker lock reuse to the full release provenance manifest: Bind Docker lock reuse to the full release provenance manifest
- The prior engine-only gate is replaced and the real 8.5.4-to-8.5.5 fixture passes while valid-but-wrong integrities for each Docker package fail.
