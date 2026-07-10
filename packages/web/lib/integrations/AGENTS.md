# Cloud Integration Boundary

This directory is Cloud's integration control plane. Keep it thin around provider packages.

## Cloud Owns

- SST secret/resource resolution. Read secrets through `Resource.<Name>.value` first, with `process.env` only as local-dev fallback.
- Backend provider credentials and base URLs are resolved here and only here. Route modules, webhook handlers, proxy handlers, and sync workers must consume `resolveProviderBackendConfig` instead of reading `Resource.*` or backend API key env vars directly.
- Workspace/session/relayfile-JWT authorization, route responses, provider catalog policy, aliases, and `workspace_integrations` database persistence.
- Sync queueing, writeback orchestration, audit logging, and Cloud-specific readiness aggregation.

## Provider Packages Own

- Third-party API mechanics: connect sessions, connected-account links, connection lookup/delete/health, proxy request shaping, records APIs, webhook normalization, trigger subscription APIs, and provider-specific response parsing.
- Prefer `@relayfile/provider-nango`, `@relayfile/provider-composio`, or the relevant `@relayfile/provider-*` package before adding provider-specific REST or SDK logic here.
- `records/list` pagination, cursor handling, response unwrapping, and backend-specific error normalization belong in the provider package's `ProviderBackend.listRecords` implementation. Future records-fetching work should extend the relevant provider adapter rather than adding Nango or Composio mechanics to `nango-sync-queue.ts`, sync workers, or route handlers.

## Rules For New Work

- If a Cloud route needs a third-party API call and the provider package lacks a helper, add the helper in `../relayfile-providers` first, then call it here.
- Do not introduce new direct `@nangohq/node` or Composio SDK usage in route files. Existing `nango-service.ts` exposes a compatibility bridge for currently-installed package versions; do not copy that fallback into new providers.
- When adding a new SST Secret or binding, follow the six-place SST resource registration rule in the repo root `AGENTS.md`.
- When adding or changing any Relayfile-backed integration, follow the repo root Relayfile Integration Digest Contract: provider writes must emit Relayfile events, terminal provider states must remain as readable records instead of tombstones, and digest coverage/tests must ship in the same PR.

## Webhook Ingress & Composio (read before touching webhook routing)

A provider's webhooks reach Cloud through an upstream **normalizer** that
verifies the provider signature and delivers to one Cloud ingress endpoint;
Cloud then runs the shared pipeline (`nango-webhook-router` → relayfile →
agent-gateway) regardless of upstream. Three distinct roles — do not conflate:

- **Nango** = default normalizer (`<provider>-relay`, delivers to
  `nango-webhook-route`). Default backend is always Nango for every provider
  (`getDefaultBackend`); Composio is explicit opt-in
  (`requestedBackend: "composio"`).
- **Hookdeck** = Nango-capability-gap filler, **GitLab only** (Nango has no
  GitLab webhook support). Not generic retry/observability hardening. Do not
  add Hookdeck to any path where the normalizer can already ingest the
  provider.
- **Composio** = its own normalizer for Composio-bridge accounts; intended
  design is Composio → signed Cloud ingress route → same pipeline. No Hookdeck
  for Composio; delivery durability is the existing webhook queue/DLQ.

`<provider>-composio-relay` Nango integrations are **dynamically created** as
provider type `unauthenticated` (`ensureNangoComposioBridgeIntegration`); they
are valid for any provider and not expected to pre-exist. **Composio
dynamic-integration sync/webhook is NOT hooked up yet** — a Composio-connected
provider not syncing or triggering is *expected*, not a routing bug. Do not
"fix" it by rejecting Composio for nango-only providers, nulling bridge-key
map entries, or patching `NANGO_PROVIDER_TO_WORKSPACE_PROVIDER` piecemeal (that
was closed PR #733; wrong premise). See
`.claude/rules/webhook-ingress-architecture.md`. To run a proactive-trigger
E2E today, connect via Nango (`<provider>-relay`), not Composio.

## Writeback Bridge

- The writeback bridge owns provider-specific request shaping, not backend selection for a workspace integration.
- Add future Composio writeback support through the `getIntegrationBackend()` registry rather than by adding another bridge-local proxy helper.
- `resolveBackendIntegrationId` is the only bridge helper that reads `providerConfigKey` or `backendIntegrationId` from a `WorkspaceIntegrationRecord`; do not duplicate that lookup in per-provider writeback handlers.
