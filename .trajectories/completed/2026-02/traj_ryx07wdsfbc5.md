# Trajectory: Wave 9: SDK HttpClient + Relay class + tests

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** February 8, 2026 at 12:08 AM
> **Completed:** February 8, 2026 at 12:12 AM

---

## Summary

Added fetch-based HttpClient with retries + Relay workspace/agents APIs + Relay tests; added minimal AgentClient wrapper for NodeNext import

**Approach:** Standard approach

---

## Key Decisions

### HttpClient retry policy: up to 3 retries (4 total attempts) with backoffs 200/400/800ms
- **Chose:** HttpClient retry policy: up to 3 retries (4 total attempts) with backoffs 200/400/800ms
- **Reasoning:** Spec lists 200/400/800ms backoffs; implementing as 3 retries aligns with list length and allows all three delays to be exercised/tested.

### Add minimal packages/sdk/src/agent.ts to satisfy NodeNext module resolution for Relay.as()
- **Chose:** Add minimal packages/sdk/src/agent.ts to satisfy NodeNext module resolution for Relay.as()
- **Reasoning:** relay.ts must import AgentClient from ./agent.js; without an agent.ts the SDK build fails. Worker-9B can extend this file in-place.

---

## Chapters

### 1. Work
*Agent: default*

- HttpClient retry policy: up to 3 retries (4 total attempts) with backoffs 200/400/800ms: HttpClient retry policy: up to 3 retries (4 total attempts) with backoffs 200/400/800ms
- Add minimal packages/sdk/src/agent.ts to satisfy NodeNext module resolution for Relay.as(): Add minimal packages/sdk/src/agent.ts to satisfy NodeNext module resolution for Relay.as()
