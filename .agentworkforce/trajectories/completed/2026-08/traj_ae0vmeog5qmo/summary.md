# Trajectory: Make node load telemetry honest and explicit

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 6, 2026 at 06:58 AM
> **Completed:** August 6, 2026 at 07:00 AM

---

## Summary

Made node load unavailable by default, require explicit measurement provenance, keep max_agents=0 consistently unlimited, guard future heartbeat timestamps, and update all SDK/API types with comprehensive tests.

**Approach:** Standard approach

---

## Key Decisions

### Require an explicit load_reported signal before trusting numeric node load
- **Chose:** Require an explicit load_reported signal before trusting numeric node load
- **Reasoning:** Every released provider hard-coded numeric placeholders, including finite-capacity providers, so neither legacy zero nor max_agents alone proves a measurement; explicit additive provenance preserves compatibility and honesty.

### Keep max_agents zero as unlimited and aggregate mixed providers as unlimited
- **Chose:** Keep max_agents zero as unlimited and aggregate mixed providers as unlimited
- **Reasoning:** Placement already treats zero as unlimited, and a single unlimited provider makes the node aggregate unbounded; additive zero previously produced a false finite cap.

### Reject negative heartbeat ages as fresh
- **Chose:** Reject negative heartbeat ages as fresh
- **Reasoning:** Node timestamps are server-stamped, but persisted future timestamps can still occur; an explicit lower bound prevents future data from bypassing the freshness TTL.

---

## Chapters

### 1. Work
*Agent: default*

- Require an explicit load_reported signal before trusting numeric node load: Require an explicit load_reported signal before trusting numeric node load
- Keep max_agents zero as unlimited and aggregate mixed providers as unlimited: Keep max_agents zero as unlimited and aggregate mixed providers as unlimited
- Reject negative heartbeat ages as fresh: Reject negative heartbeat ages as fresh
