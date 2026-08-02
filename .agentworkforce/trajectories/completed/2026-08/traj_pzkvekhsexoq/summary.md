# Trajectory: Implement atomic ResolveOrReserve for deterministic 1:1 DMs

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 2, 2026 at 08:11 AM
> **Completed:** August 2, 2026 at 08:26 AM

---

## Summary

Added atomic 1:1 DM ResolveOrReserve reservations with migration backfill, fail-closed digest collision handling, and concurrent negative-control coverage.

**Approach:** Standard approach

---

## Key Decisions

### Reserve deterministic 1:1 DM ids in a dedicated tuple table before creating channel or conversation rows
- **Chose:** Reserve deterministic 1:1 DM ids in a dedicated tuple table before creating channel or conversation rows
- **Reasoning:** The reservation must name workspace plus sorted pair in one conflict-detecting upsert. Reserving first prevents colliding requests from creating shared metadata before a winner exists, and a separate table can backfill existing DMs without changing nullable group-DM columns.

---

## Chapters

### 1. Work
*Agent: default*

- Reserve deterministic 1:1 DM ids in a dedicated tuple table before creating channel or conversation rows: Reserve deterministic 1:1 DM ids in a dedicated tuple table before creating channel or conversation rows
- The reservation-first design passes the real concurrent send path and its negative control. Full engine build, lint, and 536-test suite are green; root/package-wide unrelated runner/load failures were isolated and the SDK timeout rerun passed 416/416.
