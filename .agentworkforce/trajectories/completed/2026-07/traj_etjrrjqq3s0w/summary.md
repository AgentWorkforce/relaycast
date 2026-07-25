# Trajectory: Babysit Relaycast PR #2798 for issue 294 to green human review

> **Status:** ✅ Completed
> **Task:** REL-294
> **Confidence:** 97%
> **Started:** July 22, 2026 at 12:26 AM
> **Completed:** July 22, 2026 at 01:00 AM

---

## Summary

Babysat issue 294 to a green Relaycast PR: hardened native identity classification, made the E2E harness self-host the real gateway, strengthened native-skill and certification coverage, resolved review feedback, and verified the discover-to-engage round trip.

**Approach:** Standard approach

---

## Key Decisions

### Make npm run e2e self-host the real Node gateway when no base URL is supplied
- **Chose:** Make npm run e2e self-host the real Node gateway when no base URL is supplied
- **Reasoning:** Issue 294 requires a single-command real HTTP round trip; preserving an explicit URL keeps remote and already-running gateway use intact.

### Restrict native directory results to agent identities
- **Chose:** Restrict native directory results to agent identities
- **Reasoning:** Human and system Relay identities can receive DMs but are not discoverable agents; filtering in SQL prevents their personas and addresses from leaking into the A2A team directory while registered external agents remain represented through a2a_agents.

---

## Chapters

### 1. Work
*Agent: default*

- Make npm run e2e self-host the real Node gateway when no base URL is supplied: Make npm run e2e self-host the real Node gateway when no base URL is supplied
- Issue implementation passes targeted and full unit/build/lint gates plus a 109-check self-hosted gateway E2E. The handoff PR number is cross-repo stale (cloud#2798); Relaycast branch is pushed but has no PR, so the remaining path is commit babysitter fixes, open the correct Relaycast PR, and gate its fresh checks.
- Restrict native directory results to agent identities: Restrict native directory results to agent identities
- Issue 294 now has exhaustive local verification and review feedback is resolved: native and A2A merge/filter/addressing work over a booted gateway, non-agent identities are excluded, and package/docs/OpenAPI remain aligned.

---

## Artifacts

**Commits:** 0dade133, a3a27371
**Files changed:** 4
