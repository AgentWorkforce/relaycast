# Slack Conversational Agent Routing — Phase 1 SPEC

Source of truth for `workflows/slack-conversational-routing.ts`. All agents
implementing this feature must read this file first.

## §1 Problem and current flow (traced 2026-06-04)

When a user @-mentions the "Agent Relay" Slack app, the event flows but
dead-ends before any reply:

1. Nango forwards the `app_mention` to `routeForwardEvent` →
   `handleSlackRelayfileForward`
   (`packages/web/lib/integrations/nango-webhook-router.ts:2683`).
2. Workspace resolve via `findWorkspaceIntegrationByConnection("slack", connectionId)`
   at `nango-webhook-router.ts:2700`. Missing row → event silently discarded
   (`:2704-2714`).
3. Normalized to a `SlackMessage` record, written to relayfile at
   `/slack/channels/{channelId}/messages/{ts}` with `eventType: "app_mention"`
   (`:2748-2766`).
4. `enqueueIntegrationWatchEvent` (`:2770`) →
   `packages/web/lib/proactive-runtime/integration-watch-dispatcher.ts:1232`
   queries candidate agents with `watch_globs`/`watch_rules` (`:760-795`) and
   matches via `agentMatchesEvent` (`:1313-1323`).
5. **Dead end A:** no deployed agent matches slack `app_mention` → dispatcher
   logs no-match and returns (`:1398-1410`).
6. **Dead end B:** even on a match, generic personas have no reply-back path.
   Only Ricky has Slack egress (`packages/web/lib/ricky/slack/egress.ts:31`),
   a separate product on the `slack-ricky` connection.

The Slack app manifest (`integrations/slack/manifest.json`) already grants
`chat:write` and `chat:write.customize`, so posting replies (including
per-agent `username`/`icon_url` overrides) is authorized today.

## §2 Phase 1 scope — dormant, flag-gated

Ship the routing + reply seam, **dark**. Default behavior with the flag off is
byte-identical to today (proven by test). All work is in the cloud repo only —
no persona-kit changes are needed because `parseCapabilities` passes unknown
capability keys through verbatim (workforce `persona-kit/src/parse.ts:901-936`).

Deliverables:

- **D1** — `conversational` capability in the cloud capability registry.
- **D2** — pure routing module selecting which deployed agent answers a
  Slack conversational event.
- **D3** — Slack streaming egress module mirroring the agent-assistant
  `SlackProgressStreamEgress` contract (startStream/appendStream/stopStream).
- **D4** — flag-gated dispatcher wiring: on slack `app_mention`, select the
  agent, post an immediate ack via D3, enqueue delivery through the existing
  queue path with a conversational payload marker.
- **D5** — tests for all of the above, including a flag-off no-behavior-change
  proof.

## §3 Non-goals (explicit follow-ups, do NOT build now)

- The actual streamed model turn (agent-assistant harness `streamStep` bridge,
  continuation store, thread session table). Phase 1 delivers events through
  the existing delivery path after the ack.
- Thread-stickiness persistence. D2 accepts an injected async
  `threadOwnerLookup(channel, threadTs)` seam; Phase 1 wires it to a stub that
  returns null. No DB migration in this PR (therefore no drizzle journal
  change).
- DM (`message.im`) routing. Phase 1 handles `app_mention` only.
- Any change to `handleSlackRelayfileForward` ingestion/normalization.

## §4 D1 — `conversational` capability

File: `packages/core/src/proactive-runtime/capabilities.ts`.

- Add `"conversational"` to the `CapabilityName` union (line ~4).
- Add `CAPABILITY_ALIASES.conversational = [{ kind: "capability", key: "conversational" }]`.
- Add `isConversationalPersona(spec: unknown): boolean` using the existing
  `hasPersonaCapability` path.
- Add `conversationalConfig(spec: unknown)` returning a normalized object:
  `{ enabled: boolean; defaultResponder: boolean; channels: string[]; identity?: { username?: string; iconUrl?: string } }`.
  Follow the shape/normalization style of the existing `capabilityConfig`
  handling for `teamSolve`.
- HARD RULE: read capabilities only through the `personaCapabilities()`
  resolver — never raw `spec.capabilities` (the wrapped-snapshot regression
  class from cloud#1649; see `.claude/` history and existing resolver usage).

## §5 D2 — routing module

New file: `packages/web/lib/integrations/slack-conversation/router.ts`.

Pure function, no I/O:

    selectConversationalAgent(input: {
      candidates: ConversationalCandidate[];   // already filtered to conversational personas
      event: { channel: string; threadTs?: string; text: string };
      threadOwner?: string | null;             // resolved by caller via the lookup seam
    }): { kind: "selected"; agent: ConversationalCandidate; via: "thread" | "prefix" | "channel" | "default" }
     | { kind: "ambiguous"; candidates: ConversationalCandidate[] }
     | { kind: "none" }

Precedence (first match wins):

1. **thread** — `threadOwner` matches a candidate's deployed name.
2. **prefix** — first token of the mention text after stripping the leading
   `<@U…>` bot mention matches a candidate's deployed name (case-insensitive,
   optional trailing colon).
3. **channel** — exactly one candidate's `conversationalConfig().channels`
   contains the event channel (accept both channel IDs and `#name` forms as
   opaque strings; no Slack API lookups in this module).
4. **default** — exactly one candidate has `defaultResponder: true`.
5. More than one survivor at any tier that requires uniqueness → `ambiguous`
   with the surviving candidates. Zero candidates → `none`.

## §6 D3 — Slack streaming egress

New file: `packages/web/lib/integrations/slack-conversation/egress.ts`.

Mirror the agent-assistant `SlackProgressStreamEgress` contract so a follow-up
can swap in `@agent-assistant/surfaces` without call-site changes:

- `startStream({ channel, threadTs, markdownText, identity? })` →
  `chat.postMessage` (reply in thread via `thread_ts`), returns `{ ok, ts }`.
- `appendStream({ channel, ts, markdownText })` → `chat.update`.
- `stopStream({ channel, ts, markdownText? })` → final `chat.update`.

Requirements:

- Constructor/factory takes injected dependencies:
  `{ fetchImpl?: typeof fetch; resolveBotToken: (workspaceId: string) => Promise<string | null> }`.
  Tests inject a mock fetch; production wires `resolveBotToken` through the
  existing Nango connection-credentials helper (see
  `packages/web/lib/integrations/nango-service.ts` for the canonical
  Resource-first secret pattern — never bare `process.env`).
- Throttle `appendStream` to at most 1 `chat.update` per second per message
  `ts` (coalesce: latest text wins; trailing update must flush).
- `identity` maps to `username`/`icon_url` on `chat.postMessage`
  (`chat:write.customize` is granted in the manifest).
- Non-2xx or `ok: false` Slack responses return a structured error result —
  never throw into the dispatcher path.
- Prior art for response handling: `packages/web/lib/ricky/slack/egress.ts`.

## §7 D4 — dispatcher wiring (flag-gated)

File: `packages/web/lib/proactive-runtime/integration-watch-dispatcher.ts`.

- Add a feature flag helper `isSlackConversationRoutingEnabled()` in
  `packages/web/lib/integrations/slack-conversation/flag.ts`, defaulting to
  OFF. Mirror the existing dispatcher flag prior art (e.g. the team-launch N=1
  gate) for how flags are read.
- Insertion point: inside `dispatchIntegrationWatchEvent` after candidate
  matching (`:1313-1323`), only when `provider === "slack"` and
  `eventType === "app_mention"` and the flag is ON:
  1. Filter matched candidates to conversational personas via D1
     (`isConversationalPersona` on the persona-level resolved spec).
  2. Resolve `threadOwner` via the (stub) lookup seam; call D2.
  3. `selected` → post ONE ack via D3 `startStream` (this is the only inline
     Slack call — a single fast postMessage; the model turn itself must NOT
     run inline in the webhook context — CF Worker waitUntil kill class from
     cloud#1808), then enqueue the delivery through the EXISTING enqueue path
     with an added payload marker
     `slackConversation: { channel, threadTs, ackTs, selectedVia }`.
  4. `ambiguous` → post one message listing candidate agent names, do not
     enqueue.
  5. `none` → fall through to today's behavior unchanged.
- Flag OFF → zero new code paths execute. The diff to this file must be
  minimal and additive; do not restructure existing dispatch logic.

## §8 D5 — test contract

All new tests under `tests/proactive-runtime/slack-conversation/` (so gates
can glob one directory) plus one extension of an existing file:

- Extend `tests/proactive-runtime/capabilities.test.ts`: boolean form, object
  form with `defaultResponder`/`channels`/`identity`, disabled form, and the
  wrapped `{persona, agent}` snapshot shape resolving through
  `personaCapabilities()`.
- `tests/proactive-runtime/slack-conversation/router.test.ts`: every
  precedence tier, tier-uniqueness → ambiguous, none, prefix stripping of the
  bot mention token, case-insensitivity.
- `tests/proactive-runtime/slack-conversation/egress.test.ts`: mock fetch;
  start→append→stop sequencing, thread_ts propagation, identity override
  fields, throttle coalescing (fake timers ok), trailing flush, non-ok Slack
  response → structured error (no throw).
- `tests/proactive-runtime/slack-conversation/dispatcher-flag.test.ts`:
  flag OFF → dispatch of a slack app_mention event produces byte-identical
  behavior to today (no egress calls, normal no-match/match results); flag ON
  with one conversational candidate → exactly one ack posted and one delivery
  enqueued with the `slackConversation` marker; flag ON ambiguous → one
  disambiguation message, no delivery. Follow the existing dispatcher test
  harness/mocks in `tests/proactive-runtime/` for prior art.

Test runner: node test via tsx, same as the repo convention
(`npx tsx --test tests/proactive-runtime/slack-conversation/*.test.ts`).

## §9 Constraints and repo rules

- Dormant flip discipline: flag default OFF; this PR must be a no-op in
  production until the flag is enabled.
- SST secrets: any secret read goes through a Resource-first helper
  (`.claude/rules/sst-secrets.md`). Phase 1 should need NO new SST resources —
  the bot token comes from the existing Nango connection credentials. If an
  implementer believes a new secret is required, STOP and write it as an open
  question in the reflection artifact instead of wiring it.
- No drizzle migrations in this PR (no journal change needed).
- Do not hand-copy contracts from `@relayfile/adapter-*` packages
  (`.claude/rules/relayfile-adapter-source-of-truth.md`) — not expected to be
  relevant, but binding if it comes up.
- Match surrounding code style; keep the dispatcher diff additive and small.

## §10 Acceptance contract

1. `npx tsx --test tests/proactive-runtime/slack-conversation/*.test.ts` green.
2. `npx tsx --test tests/proactive-runtime/capabilities.test.ts` green.
3. `npm run typecheck` green.
4. Regression: `npm run web:webhook-ingress:test` and
   `npx tsx --test tests/proactive-runtime/*.test.ts` green.
5. Flag-off no-behavior-change test exists and is green.
6. New files exist: router.ts, egress.ts, flag.ts under
   `packages/web/lib/integrations/slack-conversation/`, and the three new test
   files under `tests/proactive-runtime/slack-conversation/`.
7. `capabilities.ts` exports `isConversationalPersona` and
   `conversationalConfig`.
