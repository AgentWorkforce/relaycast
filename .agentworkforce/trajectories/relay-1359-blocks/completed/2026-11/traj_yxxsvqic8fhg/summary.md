# Trajectory: Preserve realtime blocks for Relay issue1359

> **Status:** ✅ Completed
> **Task:** [1359](https://github.com/AgentWorkforce/relay/issues/1359)
> **Confidence:** 95%
> **Started:** November 7, 2026 at 05:33 PM
> **Completed:** November 7, 2026 at 05:33 PM

---

## Summary

Preserved realtime blocks for channel messages, updates, threads, DMs and group DMs. SDK521, shared types278, strict types, build and lint pass; independent companion review PASS; no release or production access.

**Approach:** Standard approach

---

## Key Decisions

### Repair both websocket schema parsing and node delivery transforms

- **Chose:** Repair both websocket schema parsing and node delivery transforms
- **Reasoning:** Both paths independently drop blocks. Preserve absent/null/empty payloads and nested DM precedence. Cross-repo built SDK -> Relay adapter -> public listener parity passes for49KB blocks against fixture REST readback.

---

## Chapters

### 1. Work

_Agent: default_

- Repair both websocket schema parsing and node delivery transforms: Repair both websocket schema parsing and node delivery transforms

Final validation evidence and scope:

- In this Relaycast checkout: npm --prefix packages/sdk-typescript test (531 passed, includes strict workspace typecheck); npm --prefix packages/types test (281 passed); npm --prefix packages/engine exec vitest run src/engine/**tests**/wsTransform.test.ts (43 passed).
- Build/lint checked by the implementation agent: npm --prefix packages/sdk-typescript run build; npm --prefix packages/engine run build; SDK, types and engine lint. Local prerequisite builds used tsc for packages/types and packages/a2a.
- Native database-backed engine tests were attempted but unavailable: better-sqlite3 has no WindowsARM64/Node24 prebuilt addon locally. This is not an engine-suite pass.
- Separately in the Relay checkout, the root ran node C:/Users/hello/AppData/Local/Temp/relay-1359-crossrepo.mjs using built SDKs and mocked fetch/WebSocket I/O. The original arbitrary kind/payload object and49KB blocks matched public Relay listener and REST readback. This was not a live-service or database integration test.
- Exact implementation commit range and changed files are recorded in trajectory.json; the subsequent metadata-only commit records this evidence.
