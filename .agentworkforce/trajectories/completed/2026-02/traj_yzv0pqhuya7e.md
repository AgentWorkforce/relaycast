# Trajectory: Rename SDK directories to sdk-typescript and sdk-python

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 20, 2026 at 07:36 PM
> **Completed:** February 20, 2026 at 07:48 PM

---

## Summary

Renamed packages/sdk -> packages/sdk-typescript and packages/python-sdk -> packages/sdk-python, updated path references (AGENTS, e2e import, sdk package metadata, tsconfig references), and validated with turbo tests plus python sdk tests.

**Approach:** Standard approach

---

## Key Decisions

### Renamed SDK directories to language-specific names
- **Chose:** Renamed SDK directories to language-specific names
- **Reasoning:** Aligned monorepo layout with future expansion (sdk-typescript, sdk-python, later sdk-rust) while keeping package names unchanged for consumers.

### Updated TS project references and lockfile after directory moves
- **Chose:** Updated TS project references and lockfile after directory moves
- **Reasoning:** Renaming folders broke TS references in mcp/react/openclaw and left a stale lockfile entry; both were fixed to keep turbo builds/tests green.

---

## Chapters

### 1. Work
*Agent: default*

- Renamed SDK directories to language-specific names: Renamed SDK directories to language-specific names
- Updated TS project references and lockfile after directory moves: Updated TS project references and lockfile after directory moves
