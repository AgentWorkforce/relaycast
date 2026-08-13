# Trajectory: Address PR #326 review feedback

> **Status:** ✅ Completed
> **Task:** relaycast#326
> **Confidence:** 96%
> **Started:** August 13, 2026 at 11:51 PM
> **Completed:** August 14, 2026 at 12:02 AM

---

## Summary

Addressed PR #326 review findings by bounding DM conversation limits at 100 across REST/OpenAPI/MCP, using SQLite insertion rowid for deterministic same-second recency, restoring omitted-limit MCP coverage, and adding red/green regression tests. Engine and MCP full suites, builds, lint, diff check, and secret scan pass.

**Approach:** Standard approach

---

## Key Decisions

### Use SQLite dm_conversations rowid as the same-second recency tiebreaker
- **Chose:** Use SQLite dm_conversations rowid as the same-second recency tiebreaker
- **Reasoning:** The schema has no explicit monotonic sequence and deterministic DM ids are hashes. dm_conversations is a normal rowid table, inserts never provide rowid, and production has no conversation-delete path, so rowid preserves insertion chronology without a risky table rebuild.

### Reject DM conversation limits above 100 at API and MCP validation
- **Chose:** Reject DM conversation limits above 100 at API and MCP validation
- **Reasoning:** A bounded Zod schema prevents oversized enrichment reads, matches the established endpoint ceiling, and keeps OpenAPI, MCP, and README contracts aligned.

---

## Chapters

### 1. Work
*Agent: default*

- Use SQLite dm_conversations rowid as the same-second recency tiebreaker: Use SQLite dm_conversations rowid as the same-second recency tiebreaker
- Reject DM conversation limits above 100 at API and MCP validation: Reject DM conversation limits above 100 at API and MCP validation
