# Trajectory: Refactor: declare node delivery class in @relaycast/types and route events through one dispatcher

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** September 2, 2026 at 04:20 AM
> **Completed:** September 2, 2026 at 04:34 AM

---

## Summary

Declared the node frame kind in @relaycast/types (`NODE_DELIVER_FRAME_EVENT_TYPES` / `nodeFrameKindFor`), added `engine/eventDispatch.ts` as the single sink dispatcher, and rewired `fanout.ts`, `deliveryRouting.ts` and `agent.ts` onto it. `nodeContext.ts` now reports per-node send failures as an `AggregateError` instead of swallowing them, and the dispatcher reports a rejected workspace-log append.

**Verification:** `npx turbo build` (9/9 tasks), `npx turbo lint` (13/13 tasks), `npx turbo test` (18/18 tasks — 714 engine tests in 69 files, 206 types tests in 7 files, plus sdk/mcp/react/a2a/observer-dashboard/cli/openclaw), and `npx tsc --noEmit -p packages/engine` (clean).

## Commits

- `3f8ba166f5602daa140c00ebce95ea6a3cbb323b` — the original refactor.
- `d384d389fa2932ff05cb875696445c4be4225a5f` — review round: frame-kind rename, sink-failure reporting, docstrings.
- A later commit extended `NODE_DELIVER_FRAME_EVENT_TYPES` with the caller-addressed deliver-frame types and amended this record (`commits` and `_trace.endRef` now end at `d384d38`); that commit itself only touches the declaration, its tests/docs, and these trajectory files. The tool cannot amend a completed trajectory, so this was hand-edited.

**Approach:** Standard approach

---

## Key Decisions

### Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts
- **Chose:** Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts
- **Reasoning:** The durable/ephemeral split was a hard-coded Set inside a route file and the sink fan-out was hand-assembled in fanout.ts, deliveryRouting.ts and agent.ts; one dispatcher keyed off a types-level declaration removes the drift risk while keeping nodeContext.ts as the transport layer

---

## Chapters

### 1. Work
*Agent: default*

- Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts: Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts
