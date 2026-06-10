# RFC: `origin_actor_type` — typed orchestrator/sender attribution

Status: Draft · Owner: TBD · Breaking: yes (no back-compat aliases; telemetry
data intentionally breaks)

## Summary

Replace the single, CLI-centric `harness` dimension with a typed pair on the
existing origin family:

- **`origin_actor_type`** — a closed enum describing *what kind* of actor is
  driving the request: `harness | human | app | service | unknown`.
- **`origin_actor`** — the free-form identifier (UA-style) of that actor:
  `claude-code`, `codex`, `acme-orchestrator/1.4`, a user handle, etc. This is
  the generalization of today's `harness` value.

This makes attribution correct for orchestrators that are **not** coding CLIs —
a human spawning agents by hand, or an application embedding `@relaycast/sdk`
programmatically — instead of collapsing them to `harness="unknown"`.

## Motivation

Today `harness` answers "which coding tool is driving this request" and is
populated by walking the process tree for known CLI names
(`claude`, `codex`, `cursor`, `gemini`, …). The engine accepts any well-formed
string, and the SDK docs already list `"human"` as a legal value — but **only
coding CLIs are ever auto-detected**. Everything else falls through to
`unknown`:

| Orchestrator | Today | Should be |
|---|---|---|
| Claude Code driving a swarm | `harness=claude-code` ✅ | `actor_type=harness`, `actor=claude-code` |
| A human running `relaycast up` by hand | `harness=unknown` ❌ | `actor_type=human` |
| An app calling the SDK (`AcmeOrchestrator`) | `harness=unknown` ❌ | `actor_type=app`, `actor=acme-orchestrator` |
| A backend service / cron | `harness=unknown` ❌ | `actor_type=service`, `actor=...` |

Two problems with the status quo:

1. **No type dimension.** You can't segment "harness vs human vs app" without
   string-parsing a free-form field, and non-CLI orchestrators are
   indistinguishable from genuinely-unknown traffic.
2. **The name lies.** `harness` reads as "a coding CLI," which discourages app
   authors from self-identifying even though the field already permits it.

The fix is a typed, explicitly-declarable actor — auto-inference stays as the
fallback for the coding-CLI case only.

## Design

### Fields

Fold the actor into the existing `origin_*` family (which already groups sender
metadata: `origin_surface`, `origin_client`, `origin_version`):

```ts
// packages/types/src/telemetry.ts — telemetryOriginSchema
origin_surface:    string(32)   // existing: cli | sdk | cloud
origin_client:     string(80)   // existing: @relaycast/sdk-rust, ...
origin_version:    string(48)   // existing: SDK version
origin_actor_type: enum         // NEW: harness | human | app | service | unknown
origin_actor:      string(120)  // NEW: free-form id (replaces `harness`)
```

`origin_actor` keeps the existing harness validation: lowercased, UA-style
charset (`^[a-z0-9 ._\-/():=;,+]+$`), max 120. `origin_actor_type` is a closed
enum; unknown/invalid values normalize to `unknown`.

`harness` is **removed** from `relaycast_server_*` events. No alias.

### Wire contract

Replace the harness header/query; the actor rides as two values (header for
HTTP, query for WS upgrades — same dual mechanism as today):

| Old | New |
|---|---|
| `X-Relaycast-Harness: <id>` | `X-Relaycast-Origin-Actor: <id>` + `X-Relaycast-Origin-Actor-Type: <type>` |
| `?harness=<id>` | `?origin_actor=<id>` + `?origin_actor_type=<type>` |

Extraction mirrors `extractHarness` (`packages/engine/src/lib/origin.ts`):
read header → fall back to query → sanitize → default. `origin_actor_type` is
validated against the enum (default `unknown`); `origin_actor` against the
UA-charset (default empty → omitted).

A request that sends `origin_actor` but no `origin_actor_type` defaults its type
to `unknown` (the server does not guess the type from the id — the SDK is
expected to send both).

### SDK API

Replace `with_harness` with an explicit, typed declaration:

```rust
// sdk-rust
RelayCastOptions::new(key)
    .with_origin_actor(OriginActorType::App, "acme-orchestrator/1.4")
// or .with_origin_actor(OriginActorType::Human, /* id optional */ None)
```

```ts
// @relaycast/sdk
new RelayCast({
  apiKey,
  originActor: { type: 'app', id: 'acme-orchestrator/1.4' },
})
```

Env (replacing `RELAYCAST_HARNESS` / `AGENT_RELAY_ORCHESTRATOR_HARNESS` / …):

```
AGENT_RELAY_ORIGIN_ACTOR_TYPE = harness | human | app | service
AGENT_RELAY_ORIGIN_ACTOR      = <id>
```

Resolution order is unchanged in shape: explicit option → env → auto-inference.

### Auto-inference (fallback only)

The CLI/broker continues to walk the process tree, but now produces a typed
result:

- Known coding CLI in the ancestry (`infer_harness_from_command`) →
  `{ type: harness, actor: <claude-code|codex|…> }`.
- No coding CLI but launched **interactively** (TTY, no orchestrator env) →
  `{ type: human }`.
- Nothing identifiable → `{ type: unknown }`.

Apps/services are **never inferred** — they self-declare via the SDK API/env.
The orchestrator value is still set once by the outermost CLI
(`bootstrap.ts` propagation) and inherited by children; **per-worker
attribution** (relay#1078) overrides `origin_actor` per spawned agent with the
worker's CLI (`type=harness`).

## Telemetry / data impact (accepted breaking change)

- `relaycast_server_*` events lose `harness` and gain `origin_actor_type` +
  `origin_actor`.
- PostHog (project 296966) dashboards/insights/queries that reference `harness`
  must move to `origin_actor` / `origin_actor_type`. **This is an accepted hard
  break — no dual-write, no alias.** Cut over on deploy.
- Historical `harness` data remains queryable as-is; new data uses the new
  fields. Any saved insight spanning the cutover shows a gap on one field.

## Implementation plan

Ordered so the contract lands before producers/consumers:

1. **`packages/types`** — add `origin_actor_type` (enum) + `origin_actor` to
   `telemetryOriginSchema`; remove `harness`; update `normalizeTelemetryOrigin`
   + tests. Bump types.
2. **`packages/engine`** — `lib/origin.ts`: replace `HARNESS_HEADER`/
   `extractHarness`/`UNKNOWN_HARNESS` with origin-actor header+query extraction
   and enum validation. `lib/serverTelemetry.ts` + `middleware/logger.ts` +
   `engine.ts`: stash/emit `origin_actor_type`/`origin_actor` instead of
   `harness`. Update conformance tests.
3. **`packages/sdk-rust`** — `harness.rs` → `origin_actor.rs`;
   `with_harness` → `with_origin_actor`; emit both header + WS query.
4. **`packages/sdk`** (JS) — `relaycast-telemetry.ts` actor resolution + env
   keys; `withRelaycastTelemetry`. Publish.
5. **Cloud consumer** (`cloud/packages/relaycast/src/providers/telemetry.ts`) —
   lift `origin_actor_type`/`origin_actor` (today it lifts only
   `origin_surface/client/version`; `harness` rode in `properties`).
6. **`relay` repo** — bootstrap propagation env rename; `infer_harness_from_command`
   → typed inference; per-worker injection (relay#1078) sets `origin_actor`;
   add the `human` interactive default.
7. **Publish + version bump** all SDKs; bump the broker's `relaycast` pin (see
   the SDK-version-skew note — `with_origin_actor` ships in a new SDK release).

Each step keeps its package green; the engine is the only place that briefly
reads the new wire fields before producers send them (safe — defaults to
`unknown`).

## Alternatives considered

- **Keep `harness`, add only `origin_actor_type`.** Rejected: leaves the
  misleading name and a redundant id field; the user opted for a clean break.
- **Back-compat aliasing (`harness` → `origin_actor`).** Rejected explicitly —
  data is allowed to break; aliases add permanent surface for a transitional
  need.
- **Free-form `origin_actor` only, no enum.** Rejected: the whole point is
  clean segmentation (harness vs human vs app) without string heuristics.

## Open questions

1. Should `human` be auto-defaulted on interactive TTY launches, or only set
   explicitly? (Proposed: auto-default when interactive AND no harness/app.)
2. Is `service` distinct enough from `app` to be worth a separate enum value, or
   collapse to `app`?
3. Do we want an optional `origin_actor_version` separate from `origin_version`
   (SDK version), e.g. the app's own version? (Proposed: encode in the
   UA-style `origin_actor` id, e.g. `acme/1.4`, rather than a new field.)
