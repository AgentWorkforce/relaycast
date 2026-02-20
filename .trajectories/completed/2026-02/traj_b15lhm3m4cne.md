# Trajectory: Make workspace stream default disabled and remove env-var control

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** February 18, 2026 at 07:27 PM
> **Completed:** February 18, 2026 at 07:30 PM

---

## Summary

Removed ENABLE_WORKSPACE_STREAM config path; workspace stream now defaults disabled and can only be enabled with workspace-key toggle endpoint.

**Approach:** Standard approach

---

## Key Decisions

### Workspace stream defaults to disabled with no environment-variable control
- **Chose:** Workspace stream defaults to disabled with no environment-variable control
- **Reasoning:** Prevents accidental enablement across environments; stream can only be turned on per-workspace via authenticated workspace-key API

---

## Chapters

### 1. Work
*Agent: default*

- Workspace stream defaults to disabled with no environment-variable control: Workspace stream defaults to disabled with no environment-variable control
