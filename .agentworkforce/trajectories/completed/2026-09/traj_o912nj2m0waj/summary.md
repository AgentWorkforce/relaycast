# Trajectory: Repair Relaycast PR 393 release provenance and dist-tag gates

> **Status:** ✅ Completed
> **Task:** relaycast#393
> **Confidence:** 20%
> **Started:** September 9, 2026 at 02:34 AM
> **Completed:** September 9, 2026 at 02:52 AM

---

## Summary

Historical self-report about PR 393 release provenance and dist-tag decisions. This trajectory captured no commands, outputs, commits, or changed-file evidence, so implementation and validation claims are non-authoritative and non-gating.

**Approach:** Historical decision record (non-gating)

---

## Key Decisions

### Validate newly-created annotated release tags with the exact reusable-tag validator before any remote push
- **Chose:** Validate newly-created annotated release tags with the exact reusable-tag validator before any remote push
- **Reasoning:** The semantic release contract accepted syntactically valid but provenance-mismatched Docker integrities; the local tag is the first object binding the generated release tree to the signed provenance digest.

### Use npm publish --tag as the sole dist-tag mutation and fail closed on bounded exact read-back
- **Chose:** Use npm publish --tag as the sole dist-tag mutation and fail closed on bounded exact read-back
- **Reasoning:** npm trusted-publishing OIDC authorizes publish but not npm dist-tag commands. Read-only verification preserves OIDC releases, lets registry propagation converge, blocks changed/missing mappings, and never moves latest for next/alpha.

---

## Chapters

### 1. Work
*Agent: default*

- Validate newly-created annotated release tags with the exact reusable-tag validator before any remote push: Validate newly-created annotated release tags with the exact reusable-tag validator before any remote push
- Use npm publish --tag as the sole dist-tag mutation and fail closed on bounded exact read-back: Use npm publish --tag as the sole dist-tag mutation and fail closed on bounded exact read-back
- All three independent-review findings are repaired; focused release, engine, SDK, entrypoint, full workspace, build, lint, actionlint, and real-image gates are green before final security review.
