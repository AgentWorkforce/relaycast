# Trajectory: Fix relay#1471 DM inbox/list scaling

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1471
> **Confidence:** 93%
> **Started:** August 13, 2026 at 10:56 PM
> **Completed:** August 13, 2026 at 10:59 PM

---

## Summary

Fixed relay#1471 by batching DM conversation and inbox enrichment queries below D1 bound-parameter limits, wiring the advertised DM-list limit through MCP/SDK/HTTP, and adding 151-conversation D1-cap regressions.

**Approach:** Standard approach

---

## Key Decisions

### Batch DM list and inbox enrichment queries in groups of 90
- **Chose:** Batch DM list and inbox enrichment queries in groups of 90
- **Reasoning:** Hosted Cloudflare D1 allows 100 bound parameters per statement; 90 leaves headroom for other predicates and remains safe if queries gain a few scalar bindings.

### Thread the existing MCP DM-list limit through SDK and HTTP route
- **Chose:** Thread the existing MCP DM-list limit through SDK and HTTP route
- **Reasoning:** The public parameter was previously ignored; applying it before enrichment bounds work and makes the advertised control real, while chunking keeps unlimited reads safe.

---

## Chapters

### 1. Work
*Agent: default*

- Batch DM list and inbox enrichment queries in groups of 90: Batch DM list and inbox enrichment queries in groups of 90
- Thread the existing MCP DM-list limit through SDK and HTTP route: Thread the existing MCP DM-list limit through SDK and HTTP route
