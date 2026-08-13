# Trajectory: Enforce sponsor grants at Relaycast agent-registration authority

> **Status:** ✅ Completed
> **Task:** relay#1497
> **Confidence:** 91%
> **Started:** August 13, 2026 at 03:06 PM
> **Completed:** August 13, 2026 at 08:49 PM

---

## Summary

Added server-verified RelayAuth sponsor authority for hosted workspace and agent credential issuance, immutable and deletion-resistant sponsor/work-unit ownership, protected REST/node/A2A/destructive paths, guarded incumbent-token legacy binding, Rust authority APIs, OpenAPI/docs, and security regression tests.

**Approach:** Mapped every token issuance path at the portable engine boundary, verified grants against the canonical RelayAuth contract, persisted server-only claims, and threat-modeled rotation, metadata rewrite, legacy migration, and deletion/recreation.

---

## Key Decisions

### Enforce sponsor/work-unit authority in the portable engine at every external agent-token issuance path
- **Chose:** Enforce sponsor/work-unit authority in the portable engine at every external agent-token issuance path
- **Rejected:** Keep relay AuthClient checks only, Enforce only REST routes, Trust sponsor fields in agent metadata, Automatically accept null legacy bindings
- **Reasoning:** Cloudflare is only an adapter; @relaycast/engine owns REST registration/rotation and node-control agent.register. Verified RelayAuth claims are persisted in dedicated immutable columns. Legacy rows bind once only via the incumbent agent token plus fresh proof, never by workspace key or editable metadata.

### Persist credential ownership beyond live agent rows
- **Chose:** Persist credential ownership beyond live agent rows
- **Rejected:** Protect rotation only
- **Reasoning:** Immutable columns alone are erased by DELETE, allowing a workspace-key holder to delete and recreate a protected name under a different sponsor. A server-controlled (workspace,name) claim survives deletion; destructive lifecycle calls require matching proof/work-unit authority, and recreation must match the durable claim.

---

## Chapters

### 1. Work
*Agent: default*

- Enforce sponsor/work-unit authority in the portable engine at every external agent-token issuance path: Enforce sponsor/work-unit authority in the portable engine at every external agent-token issuance path
- Persist credential ownership beyond live agent rows: Persist credential ownership beyond live agent rows
- Server authority now covers every identified credential issuance path and the deletion/recreation bypass found during manual threat review. Serialized full engine suite is green (570 tests); focused Cloudflare configuration/migration tests and Rust authority wire test are green. Highly parallel all-package runs showed worker startup/test isolation timeouts, so security assertions were rerun serialized.
