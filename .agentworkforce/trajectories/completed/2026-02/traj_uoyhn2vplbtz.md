# Trajectory: Make SDK camelCase everywhere

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 20, 2026 at 02:35 PM
> **Completed:** February 20, 2026 at 02:43 PM

---

## Summary

Removed snake_case compatibility aliases from SDK inputs, standardized on camelCase call-site params, camel-cased workspace.stream + dmMessages response shapes, updated changelog and tests, and verified with sdk tests/build

**Approach:** Standard approach

---

## Key Decisions

### Add package-level SDK changelog
- **Chose:** Add package-level SDK changelog
- **Reasoning:** Need a stable version-by-version record close to package source for release notes and onboarding

### Remove snake_case compatibility aliases from SDK inputs
- **Chose:** Remove snake_case compatibility aliases from SDK inputs
- **Reasoning:** User requested a single canonical casing style; keeping aliases prolongs inconsistency and ambiguity for callers

### Camel-case selected SDK response surfaces where the SDK defines local shapes
- **Chose:** Camel-case selected SDK response surfaces where the SDK defines local shapes
- **Reasoning:** workspace.stream and dmMessages had SDK-defined interfaces with snake_case fields; mapping to camelCase keeps the SDK surface internally consistent

---

## Chapters

### 1. Work
*Agent: default*

- Add package-level SDK changelog: Add package-level SDK changelog
- Remove snake_case compatibility aliases from SDK inputs: Remove snake_case compatibility aliases from SDK inputs
- Camel-case selected SDK response surfaces where the SDK defines local shapes: Camel-case selected SDK response surfaces where the SDK defines local shapes
