# Trajectory: Desktop direct-node machine addresses

> **Status:** ❌ Abandoned
> **Task:** relay-desktop#119
> **Started:** September 29, 2026 at 02:01 PM
> **Completed:** October 11, 2026 at 12:30 PM

---

## Key Decisions

### Use normalized hostname plus the full agent id as the direct machine_id
- **Chose:** Use normalized hostname plus the full agent id as the direct machine_id
- **Reasoning:** Each desktop session owns its own direct node; the full server-issued id makes its address component unique while preserving a readable host prefix.

---

## Chapters

### 1. Work
*Agent: default*

- Use normalized hostname plus the full agent id as the direct machine_id: Use normalized hostname plus the full agent id as the direct machine_id
- Registration, roster, direct socket delivery, and legacy alias pass on a throwaway local Relaycast server
- Abandoned: Stale trajectory from a different task (Desktop direct-node machine addresses); left active for 12 days, abandoning so the relaycast D1 robustness work can be tracked.
