# Platform Architecture v1 (working draft)

**Status:** draft, not yet approved. Use as a strawman.
**Owner:** Khaliq.
**Last updated:** 2026-04-20.

## TL;DR

Four products (sage, nightcto, My-Senior-Dev, plus whatever comes next) are built on one core framework (`@agent-assistant/*`) and share three primitives:

1. **Relayfile** — one canonical per-workspace VFS of all customer data (GitHub, Linear, Slack, Notion, …). Products access it via HTTP + minted JWT, with per-product scope (mostly read-only; MSD gets a sandbox-fork capability for proposing writes).
2. **Relayauth** — the token broker that mints workspace-scoped, product-scoped, scope-limited JWTs for all cross-product API calls.
3. **Specialist Worker** — a single Cloudflare Worker hosting shared agentic specialists (GitHub, Linear, Slack, Notion, …), reachable over HTTP by any product. Each specialist has its own system prompt + tools; per-request workspace scoping ensures tenants stay isolated.

Glue:
- **Organizational layer (new)** in `cloud/` — a workspace/product/access registry + specialist routing metadata. Does NOT consolidate GitHub Apps (per D2) — each product keeps its own App + webhook endpoint; dedup lives inside relayfile's write path.
- **Cataloging agent (new)** — a proactive Worker that continuously scans the relayfile for each workspace, building summary indexes that specialists consume to answer faster.
- **GCP bridge** — MSD stays on Cloud Run. It calls relayfile / relayauth / specialist-worker over HTTPS from GCP. No dual-hosting the platform.

## Goals

- **One core framework, many products.** Everything agent-level lives in `@agent-assistant/*`. Products are thin — integrations + surface-specific glue.
- **One canonical data store per workspace.** A customer connects GitHub/Linear/Slack once; all products see the same data, kept fresh by the product whose webhook arrives first.
- **Shared specialists, workspace-isolated.** A `github_specialist` invocation from sage, nightcto, or MSD hits the same agent logic with the same prompt tuning. Each call is scoped to the caller's workspace; no cross-tenant leak.
- **Clear access policy.** A product has declared read/write scope per provider. MSD's fix-proposal path goes through a sandbox fork, not direct writes to canonical.
- **Cross-cloud is fine.** MSD on GCP is a first-class citizen, not a special case. The primitives are HTTP-reachable; the authoring cloud doesn't matter.

## Backward-compatibility invariants (hard constraints)

`@relayfile/*` and `@relayauth/*` are published npm packages with in-the-wild consumers (sage, MSD, NightCTO, and potentially external clients). **No change in this spec may break an existing consumer on the current published version.** Specifically:

1. **Additive only for public types.** New fields on `DelegationRequest`, JWT claims, `RelayFileClient` options, `WriteFile` params, etc. are all `optional`. Omitting them preserves today's behavior exactly.
2. **New endpoints never break existing ones.** Fork APIs, dedup headers, policy-check endpoints — all net-new routes. Existing `POST /v1/workspaces/:id/fs/…` behavior is frozen.
3. **Default-allow on missing metadata.** When a token lacks `product_id` (pre-migration tokens) or a write request omits `contentIdentity` (pre-migration callers), the server applies yesterday's behavior — full legacy scope, no dedup. Tightening happens *per workspace* via opt-in flags, never globally and never at the SDK boundary.
4. **Semver is MINOR bumps until we finish.** `@relayfile/sdk@0.1.13 → 0.2.0` for content-identity (additive). `→ 0.3.0` for fork APIs (additive). No `1.0.0` / major until the whole migration is done and a deprecation window has passed.
5. **No field removals or renames** on published types during this campaign. If something needs to go, it becomes a deprecated no-op first, then removed in a later major.
6. **MSD on `@relayfile/sdk@0.1.3` keeps working** through the entire migration. Version skew is fine: older SDKs just miss new features.

What this rules out: any "Week 1 = all tokens must now include product_id" scheme. That would break sage's current local-minting path and MSD's backend simultaneously. Instead see the *Backward-compat strategy per milestone* table below.

### Backward-compat strategy per milestone

| Week | Change | Public surface impact | Migration mechanic |
|---|---|---|---|
| 1 | Add `product_id` + optional scope-narrowing to JWT claims | Optional field on tokens. Tokens without it still validate. | `@relayauth/sdk` adds mint helper accepting `productId`; servers accept legacy tokens as `product_id: "legacy"` with full historic scope. Per-workspace policy flag `enforce_product_scope` defaults off; flipped on once all consumers for that workspace have migrated. |
| 1 | Relayfile enforces product scope on write | New enforcement path, gated by workspace policy | Same `enforce_product_scope` flag. Off → today's behavior. On → reject writes from tokens without matching `product_id` scope. |
| 1 | Add `workspaceId` to `DelegationRequest` / `HarnessTurnInput` | Optional field | `@agent-assistant/specialists` v0.3 (or minor bump); specialists read `request.workspaceId ?? request.metadata?.workspaceId ?? undefined`. Old callers still work; new callers benefit. |
| 2 | Specialist worker extraction | Brand new service; existing in-process path stays live in sage | Sage's `SAGE_GITHUB_SPECIALIST_URL` env var already toggles between in-process and HTTP (built in M1). Flip per-deployment when ready. No published-package change. |
| 3 | Content-identity dedup on relayfile write | New optional param on write API | `@relayfile/sdk@0.2.0`. `client.writeFile(path, content, { contentIdentity })` — old `writeFile(path, content)` calls keep working; they just don't dedup. |
| 3 | Organizational layer (workspace/product registry) | Brand new service; existing JWT validation path unchanged | Relayfile/relayauth look up policy on the new registry only when `enforce_product_scope: true`. No op for legacy workspaces. |
| 4 | Relayfile fork APIs | Brand new endpoints | `@relayfile/sdk@0.3.0`. `client.fork()` / `client.discardFork()` — old clients don't see these. |
| 4 | MSD retires `relayfile-ingest` | Internal to MSD; no public API change | No backward-compat concern. |
| 5 | Cataloging agent writes `/insights/*` | New path convention in relayfile; path is readable by any existing client | No API change. Clients that don't read `/insights/` just don't see it. |
| 6 | NightCTO consolidation | Internal to NightCTO | No public API change. |

### Version matrix (end state)

| Package | Current | End of campaign | Breaking bump? |
|---|---|---|---|
| `@agent-assistant/harness` | 0.2.12 | 0.2.13 or 0.3.0 (MINOR) | No |
| `@agent-assistant/specialists` | 0.2.11 | 0.3.0 (MINOR) | No |
| `@relayauth/sdk` | 0.1.8 | 0.2.0 (MINOR) | No |
| `@relayauth/core` | 0.1.8 | 0.2.0 (MINOR) | No |
| `@relayfile/sdk` | 0.1.13 | 0.3.0 (MINOR after 0.2.0 for content-identity, then 0.3.0 for fork) | No |
| `@relayfile/core` | 0.1.13 | 0.2.0 (MINOR) | No |

Caret ranges in consumers (`^0.1.x` / `^0.2.x`) pick up bumps automatically without code change, except where we intentionally bump the range to consume new features.

### What this means for Week-1 execution

The Week 1 PR set explicitly does NOT:
- Require all consumers to migrate before deploy.
- Change validation semantics for tokens already in the wild.
- Break any existing call site in sage / nightcto / MSD.

The Week 1 PR set DOES:
- Add `productId` / `workspaceId` as optional fields throughout.
- Ship `enforce_product_scope` as a per-workspace flag, default **off**.
- Give sage a migration path where it opts in for its own workspace first.
- Leave MSD untouched (it keeps minting legacy tokens; relayfile keeps accepting them).

When MSD's team has bandwidth, they update to the new SDK and opt their workspace in. No forced coordination.

## Non-goals (for v1)

- **Multi-region relayfile.** Stays CF-only; one home region. Revisit if latency for GCP-hosted MSD becomes painful.
- **Real-time bidirectional sync** between products' views. Eventual consistency via webhook fan-out is sufficient.
- **Per-product model selection / billing surface.** Assume OpenRouter keys live at the platform level for now. Later milestone.
- **A sandboxed write layer for every product.** Only MSD has a write-sandbox requirement today; sage and nightcto are read-only.

## Current state (what's real today)

From the survey:

| Primitive | State |
|---|---|
| `@agent-assistant/*` | Published to npm. All three products consume it. Core framework is solid. |
| Relayfile | **One canonical CF Worker** (`cloud/packages/relayfile`), per-workspace Durable Object, D1 + R2. Not per-product clones. |
| Relayauth | Exists (`cloud/packages/relayauth`), JWT-based. Underutilized — sage mints JWTs locally via `mintRelayfileToken`. |
| Webhook dedup | In-workspace only. Each product has its own Nango GitHub connection → three webhooks per GitHub event → three writes to the same relayfile (dedup'd via deliveryId in the workspace DO, but not coordinated across products). |
| Specialists | Sage has in-process agentic `github_specialist` + `linear_specialist` (PR #81). NightCTO has its own specialist packages. No shared worker. |
| Proactive | Sage has a scheduler via `@agentcron/sdk`. No cataloging agent. |
| MSD | On GCP (Cloud Run + Cloud SQL + PubSub). Consumes `@agent-assistant/*` + `@relayfile/sdk` + `@relayauth/sdk`. Has a `relayfile-ingest` service that writes GitHub events into relayfile. |

**Key mismatches with the vision:**

1. **Relayfile is "one canonical store, per-workspace," not "one clone per product that syncs."** The vision's "clones" phrasing matches neither the current implementation nor what we actually want. What we actually want is: one canonical store per workspace, with per-product read/write scope enforced by token claims. Per-product "clones" adds storage cost + consistency problems for no benefit since the workspace is the correct isolation unit.
2. **Webhook dedup across products doesn't exist yet.** Today if sage's GitHub App and MSD's GitHub App are both installed on the same repo, they both fire webhooks → double-processing. Dedup needs to move up a layer to a shared webhook fan-out router.
3. **Specialists are not a shared worker yet.** M2 from the sage roadmap. Needs to happen for nightcto and MSD to consume the same specialists as sage.
4. **No cataloging agent.** Specialists currently cold-scan the relayfile on every query. A background cataloger would pre-compute summaries + indexes.

## Proposed architecture

```
                    ┌────────────────────────────────────────────────┐
                    │          Organizational Layer (new)            │
                    │       (cloud/packages/platform)                │
                    │  • Workspace + product registry                │
                    │  • Access policy (read/write scope per product)│
                    │  • Specialist routing metadata                 │
                    │  NOTE: no webhook router; webhooks stay        │
                    │  per-product (D2).                             │
                    └──────────────┬─────────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│     Relayauth    │    │     Relayfile    │    │Specialist Worker │
│   (CF Worker)    │    │   (CF Worker)    │    │   (CF Worker)    │
│                  │    │                  │    │                  │
│ mints JWTs with  │    │ workspace-scoped │    │ shared agentic   │
│  {workspace_id,  │    │ VFS (Durable Obj │    │ specialists:     │
│   product_id,    │    │  + D1 + R2)      │    │ github, linear,  │
│   scopes, exp}   │    │                  │    │ slack, notion    │
│                  │    │ + content-hash   │    │                  │
│                  │    │   dedup on write │    │                  │
│                  │    │ + sandbox fork   │    │                  │
│                  │    │   API (MSD)      │    │                  │
└────────┬─────────┘    └────────▲─────────┘    └────────▲─────────┘
         │                       │                       │
         │     mints JWT         │  workspace-scoped     │
         │                       │  reads + writes       │
         ▼                       │                       │
┌──────────────────────────────────────────────────────────────────┐
│                        Products                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐             │
│  │    Sage     │   │  NightCTO   │   │     MSD     │             │
│  │  (CF, chat) │   │ (CF, review)│   │ (GCP, desk) │             │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘             │
└─────────┼─────────────────┼─────────────────┼───────────────────┘
          │                 │                 │
          │ each product owns its own Nango connection + webhook endpoint
          │ each writes to relayfile → relayfile dedupes by content hash
          │
          ▼                 ▼                 ▼
   ┌─────────────┐  ┌─────────────┐   ┌─────────────┐
   │  Sage's     │  │ NightCTO's  │   │   MSD's     │
   │ GitHub App  │  │ GitHub App  │   │ GitHub App  │
   │  (min perms)│  │(checks perm)│   │(contents rw)│
   └──────▲──────┘  └──────▲──────┘   └──────▲──────┘
          │                │                 │
          └────────────────┼─────────────────┘
                           │
                   ┌───────┴────────┐
                   │    GitHub      │
                   │  (customer's   │
                   │   repos)       │
                   └────────────────┘


       ┌──────────────────────────────────────────────┐
       │  Cataloging Agent (new, CF Worker)           │
       │  AgentCron-scheduled; scans each workspace's │
       │  relayfile, writes summaries to /insights/*  │
       │  for specialists to consume.                 │
       └──────────────────────────────────────────────┘
```

### The six components

**1. Relayfile** — unchanged from today. One canonical CF Worker, per-workspace Durable Object, D1 + R2 backing. **Add:** a sandbox-fork API so MSD can stage proposed writes without mutating canonical state. Fork = a lightweight copy-on-write namespace tied to a proposal; merges happen only when the customer approves the fix.

**2. Relayauth** — stop bypassing it. All products mint tokens via relayauth, not locally. Tokens carry `{workspace_id, product_id, scopes, exp}`. The relayfile server validates `product_id` against the organizational layer's policy before allowing the operation. This gives us the "read-only for sage/nightcto, read-plus-sandbox-fork for MSD" distinction without custom per-product code in relayfile.

**3. Specialist Worker (new)** — a dedicated CF Worker hosting the agentic specialists. Each specialist is the factory pattern already built in sage (M1 in-process specialists), lifted out. Interface: `POST /delegate` (A2A card served at `/.well-known/agent.json`). Every request carries a workspace-scoped token. Specialists read relayfile using that same token (delegated auth — they act on the caller's behalf, not with their own creds).

**4. Cataloging Agent (new)** — a separate proactive CF Worker triggered by AgentCron. For each workspace, periodically scans the relayfile (`/github/repos`, `/linear/issues`, etc.) and writes summary indexes back to a `/insights/` namespace in the same relayfile. Specialists read `/insights/` first, fall through to raw data if needed. Reduces specialist latency + token cost by pre-computing the common questions ("who owns what module?", "what's the backlog shape?", "which PRs are stale?").

**5. Organizational layer (new)** — the glue. Lives in `cloud/packages/platform`. Responsibilities:
   - **Workspace registry.** Which workspaces exist; which products have access to which; what scopes each product has.
   - **Product registry.** Sage, nightcto, MSD, specialist-worker, cataloging-agent each register with stable IDs. Used by relayauth to enforce token scope.
   - **Webhook fan-out + dedup router.** A single GitHub App (not per-product). All webhooks land here. For each delivery:
     1. Dedup by `X-GitHub-Delivery` header. Seen before → drop.
     2. Look up the workspace from repo full_name + installation_id.
     3. Write to relayfile once (via a service token).
     4. Fan out a notification to every product registered for the workspace so they can react in-memory (e.g., sage updates its thread state, nightcto triggers a review).
   - **Specialist routing metadata.** Map capability → specialist endpoint. Products call the organizational layer's `/specialist/delegate` → it routes to the right specialist worker + auth'd token. (This last bit is optional — products could call specialist worker directly; organizational-layer routing gives a single upgrade point for future specialist topology changes.)

**6. GCP bridge for MSD.** MSD stays on Cloud Run. Its relayfile-ingest service **retires** (the organizational layer now owns webhook ingestion; MSD reads from relayfile instead of writing to it). MSD's desktop client hits the shared specialist worker over HTTPS just like sage and nightcto do. Cross-cloud is just TLS + JWT; no special bridge service needed. The only GCP-specific pieces are MSD's own backend + UI, which were going to stay on GCP anyway.

## Key design decisions

### D1 — "Clone" or "shared" relayfile?

**Decision: shared, per-workspace-scoped.** Not per-product clones.

Why: the workspace is the right isolation unit. Per-product clones would:
- Triple storage cost.
- Force us to keep three copies in sync with eventual consistency headaches.
- Provide no security benefit (the token already enforces scope).

Your "whichever webhook arrives first wins + dedup" intuition is exactly right — but it lives in the organizational layer's webhook router, not in the relayfile itself. Relayfile stays boring.

### D2 — One GitHub App or three?

**Decision: three (one per product). Dedup at the relayfile write boundary.**

Why three:
- **Permission minimization per product.** Sage needs `read:repos,issues,pulls`. NightCTO needs `write:checks,statuses`. MSD needs `write:contents,pulls` for its fix-proposal path. A shared App would have to ask for the union → scariest install prompt → lower adoption.
- **Independent release cadence.** Each product can adjust its App's permissions without touching others. One App = lockstep releases + cross-team coordination on every permission tweak.
- **Customer choice.** Customers can install sage without MSD (or vice versa). With one shared App there's no decline granularity.
- **Rate-limit pooling.** GitHub rate limits are per-App. Three Apps = 3× the per-installation pool. Matters once any one product gets chatty.
- **Operational blast radius.** A bug in one product can't abuse permissions another product granted.

The reasons *against* three Apps collapse to "webhook dedup." That's a solved problem at the cost of a small table in the ingest path — much smaller than what we lose by forcing one App.

**How dedup works:**

Each product keeps its Nango GitHub connection and its webhook endpoint. Each product's webhook handler writes into the same shared relayfile. Relayfile's write API is **content-addressed**: the caller passes `(workspace_id, content_kind, content_identity)` where `content_identity` is a stable hash of the payload's meaningful parts — for a GitHub push event, that's `(repo_full_name, event_type, head_sha, ref)`. Relayfile checks a dedup table keyed on that tuple within a TTL window (propose 10 min, configurable) before doing the D1 + R2 writes.

Algorithm:
```
function writeFromWebhook(workspaceId, contentKind, contentIdentity, payload, productId):
  hash = sha256(workspaceId + contentKind + canonicalize(contentIdentity))
  seen = dedupTable.get(hash, ttl=10min)
  if seen:
    log.debug("dedup hit; already written by {seen.productId} at {seen.ts}")
    return { deduped: true, original_writer: seen.productId }
  dedupTable.put(hash, { productId, ts: now() }, ttl=10min)
  doActualWrite(payload)
  return { deduped: false }
```

Product-level behavior is **unchanged** — each product still reacts to its own webhook in its own runtime (sage updates threads, nightcto enqueues a review, MSD refreshes its catalog). Dedup is purely about avoiding 3× relayfile writes for the same underlying event.

**What dedup does NOT do:**
- **Does not suppress product-specific reactions.** If sage's webhook and nightcto's webhook both fire on a PR open, sage still starts a Slack thread, nightcto still starts a review. Different downstream effects — no dedup.
- **Does not deduplicate identical events *within* a single App.** GitHub delivers occasional duplicate webhooks; each App's Nango handler already handles that via `X-GitHub-Delivery` idempotency. That stays.

**Where the dedup table lives:**
- Cloudflare KV with 10-minute TTL → cheapest, good enough.
- Alternative: a new table in relayfile's D1. More queryable but higher write cost. Defer unless we need audit trails.

Migration: basically nothing. Products keep their Nango connections. Add the content-identity parameter to relayfile's write API + dedup check inside relayfile. One small relayfile PR.

### D3 — Where does MSD's "sandbox fork" live?

**Decision: in relayfile itself, as a first-class concept.**

Shape: when MSD wants to propose a change, it calls `relayfile.fork(workspaceId, {proposal_id})`. The fork is a copy-on-write view. MSD writes into the fork's namespace. When the customer approves the proposal, MSD creates an actual GitHub PR (not a relayfile merge — the real artifact is a PR). The fork is discarded once the PR is merged.

This keeps the canonical relayfile immutable from MSD writes while giving MSD a scratch space.

Alternative considered: give MSD a separate "msd-proposals" workspace. Rejected because it couples proposal identity to workspace topology, and because the fork-semantics are a cleaner concept.

### D4 — Who owns the cataloging agent's output?

**Decision: writes to `/insights/*` in the same relayfile.** No separate store.

Specialists read `/insights/*` first, fall through to raw provider data. Cataloger's outputs become part of the workspace's VFS, queryable by any product.

Alternative considered: separate "insights DB" (Vector store, etc.). Rejected for v1 because it adds a service without a clear need; relayfile's D1/R2 can hold summary JSON + TTL-based freshness.

### D5 — Specialist topology: one worker or one per provider?

**Decision: one worker hosting all specialists initially.** Split when scaling demands it.

Why: operational simplicity. Each specialist is a Hono route inside the worker. Shared deployment, shared tail logs. If github_specialist starts dominating CPU or needs its own scaling, split then — not preemptively.

### D6 — Cross-cloud auth

**Decision: relayauth-minted JWTs over HTTPS. No VPN, no service mesh.**

MSD on GCP makes the same HTTPS + Bearer calls that sage does from CF. Latency adds ~30-80ms per call for MSD vs. same-cloud products — acceptable given MSD's async review workflow (not real-time chat).

If future product-to-product traffic becomes chatty enough that latency matters, revisit — could put the specialist worker on both clouds with an identity-aware proxy. Not v1.

### D7 — What lives in agent-assistant vs. cloud?

**Decision:**
- **agent-assistant** owns: harness, tool-registry shapes, specialist factory, agentic composition primitives, typed contracts (DelegationRequest, SpecialistFindings, WorkspaceId). No per-workspace state, no infra code. Published to npm.
- **cloud** owns: deployed services (relayfile, relayauth, specialist worker, cataloging agent, organizational layer, web app), Nango integration configs, infrastructure (SST), per-workspace identity + policy. Private monorepo.

Products (sage, nightcto, MSD) pull from both — agent-assistant as npm dep, cloud as operational backend.

## Migration plan (strawman, weeks-scale)

### Week 1 — foundation
- [ ] Finalize relayauth JWT claim shape (`workspace_id` + `product_id` + `scopes`).
- [ ] Relayfile enforces `product_id` via policy lookup against the organizational layer.
- [ ] Wire sage to mint via relayauth (stop local `mintRelayfileToken`).

### Week 2 — specialist worker
- [ ] Extract sage's agentic specialists into `cloud/packages/specialist-worker`.
- [ ] Specialist worker reads relayfile with the caller's token (delegated auth).
- [ ] Sage flips to `SAGE_GITHUB_SPECIALIST_URL=https://specialist.agentrelay.com` and retires in-process path.

### Week 3 — organizational layer + relayfile dedup
- [ ] `cloud/packages/platform` — workspace/product registry + access policy.
- [ ] Keep existing per-product Nango GitHub Apps — no consolidation (see D2).
- [ ] Add `content_identity` parameter to relayfile's write API + content-hash dedup (KV-backed, 10min TTL).
- [ ] Each product's webhook handler passes a stable content identity so dedup actually hits.
- [ ] MSD retires its `relayfile-ingest` service; switches to reading from the shared relayfile. Sage + NightCTO keep their per-product webhook handlers but stop being the only writers — each writes, relayfile dedupes.

### Week 4 — MSD cross-cloud + sandbox fork
- [ ] MSD backend on GCP points at CF-hosted relayfile / relayauth / specialist worker.
- [ ] Relayfile implements `fork()` + `discard_fork()` APIs.
- [ ] MSD's proposal flow writes into a fork; on approval, opens a GitHub PR and discards the fork.

### Week 5 — cataloging agent
- [ ] `cloud/packages/cataloging-agent` — new CF Worker, AgentCron-scheduled.
- [ ] Writes summaries to `/insights/*` per workspace.
- [ ] Specialists read `/insights/` first; fall through to raw data.

### Week 6 — NightCTO consolidation
- [ ] NightCTO stops bundling its own specialist packages; calls the shared specialist worker.
- [ ] NightCTO reviews are now persistent in relayfile's `/nightcto/reviews/` namespace.

## Open questions

1. **Who funds OpenRouter token spend for shared specialists?** Today sage pays for its own. If specialist worker serves MSD too, does MSD's workspace get billed, or is it a platform cost? Proposal: per-call billing tagged with `workspace_id` via telemetry (already landing in #75); invoice later.

2. **How does the cataloging agent know when to re-catalog?** Options: (a) every time a webhook updates a workspace, enqueue a partial re-catalog; (b) periodic full scan on cron; (c) both. Default proposal: both, with (a) as the primary and (b) as a safety net.

3. **What's the fork lifetime for MSD?** Days? Hours? TTL for garbage collection? Proposal: 7 days of inactivity → discard. Configurable per proposal.

4. **Do we need a cross-cloud latency SLA for MSD?** Today GCP → CF is ~30-80ms round-trip. If a specialist invocation involves 10+ calls, that's 500ms of overhead. Probably acceptable for async reviews; painful for chat. Propose: measure, revisit.

5. **What's the dedup window for cross-product webhooks?** If sage's App and MSD's App both fire a `push` event within 2s, we dedup. What if they fire 10s apart (network delay)? Propose: 10-minute TTL on the KV dedup table, keyed on `sha256(workspace_id + event_type + repo + head_sha + ref)`. Tune upward if we see misses.

6. **How do we migrate existing workspaces?** Since we're keeping per-product Apps (D2), customers don't need to re-install. Existing Nango connections stay. The only change is that each product's webhook handler now includes a `content_identity` when writing to relayfile — a code change inside each product, zero customer action. Drop-in over a week.

7. **What about non-GitHub webhooks (Linear, Slack, Notion)?** Same pattern or different? Linear has no App concept equivalent to GitHub's; each product may need its own Linear connection. Propose: leave non-GitHub providers per-product for v1; consolidate later if volume demands.

8. **Does the organizational layer need its own DB, or can it reuse cloud's existing Postgres?** Proposal: reuse cloud's Aurora Postgres. One more schema (`platform`), not a new service.

## What this spec is NOT

- A committed plan. It's a strawman to critique.
- An implementation guide. Each component's internal design is out of scope here.
- A billing / pricing / packaging proposal.
- A customer-facing story. Marketing story is separate.

## Next steps

1. Review this doc. Red-line the design decisions.
2. Pick the 1-2 open questions that matter most and resolve them.
3. Confirm the week 1-6 sequence or reshape it.
4. Break each week's work into workflow-sized chunks.
5. Start Week 1 by the end of this week so we can demo parts of it to prospects by Wednesday.

---

## Appendix A — How the vision maps to current reality

| Vision phrase | Current reality | Gap | Fix |
|---|---|---|---|
| "Each should use the same relayfile system" | ✅ One canonical relayfile today | — | — |
| "with different access patterns" | ❌ Access is not product-differentiated today | Add `product_id` to JWT; relayfile enforces policy | D2, week 1 |
| "fork the relayfile into a sandbox" | ❌ No fork primitive | New relayfile capability | D3, week 4 |
| "relayfile clone… syncs via webhooks" | Partial — each product's webhook handler writes to relayfile independently; no cross-product dedup | Add content-hash dedup to relayfile's write API | D2, week 3 |
| "whichever webhook gets delivered first with deduping" | Missing — only in-workspace `X-GitHub-Delivery` idempotency exists | Content-identity dedup inside relayfile writes (sha256 keyed KV w/ 10min TTL) | week 3 |
| "different github connections per each" | ✅ already how it works (per-product Nango GitHub Apps) | — | — |
| "each relayfile gets a minted relayauth" | Partial — sage mints its own relayfile JWT locally | Route through relayauth | week 1 |
| "Specialists can also be shared but are their own worker" | ❌ Specialists are in-process in sage only | Extract to specialist worker | week 2 |
| "different workspaces" for specialists | ❌ Not scoped per workspace yet | Per-request workspace_id + policy enforcement | week 1-2 |
| "proactive github agent that is constantly cataloging" | ❌ Not built | New cataloging agent | week 5 |
| "organizational layer that lives in cloud" | ❌ Not built | `cloud/packages/platform` | week 3 |
| "my senior dev lives on gcp, need a way to tie this in" | Already works — MSD calls cloud APIs over HTTPS | — | — |
