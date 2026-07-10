# Proactive runtime — persona self-registration

Operator docs for the `POST /api/v1/personas/register` endpoint introduced in PR-1.1 of the proactive-unification effort. Canonical spec lives at [sage/specs/proactive-unification.md §7.1](https://github.com/AgentWorkforce/sage/blob/main/specs/proactive-unification.md#71-persona-registration).

## What it does

A first-class endpoint for hosted-service workers (Sage, NightCTO, MSD app) to register the personas they will route dispatch traffic for. Replaces the implicit "personas exist because someone ran `agentworkforce deploy`" assumption: every persona's `executor` shape is now first-class on the `agents` table and addressable from the proactive-runtime dispatcher.

The endpoint is idempotent on `(workspaceId, deployedName)`:
- Already-registered with the same executor + source tag → returns `unchanged`.
- Already-registered with a different executor → updates the row, returns `registered`.
- No row yet → returns `rejected: agent row not yet provisioned`. PR-1.3 follow-up will allow first-time creation; for the initial cut, deploy via the existing CLI flow then re-register to set the executor.

## Auth

Bearer-token auth via `resolveRequestAuth`. Two acceptable identities:

1. **Hosted-service token** — `SAGE_CLOUD_API_TOKEN` (and later `NIGHTCTO_CLOUD_API_TOKEN`, `MSD_CLOUD_API_TOKEN`). `resolveRequestAuth` maps these to `source: "service"` with the corresponding stable user id (`SAGE_SERVICE_USER_ID` today; nightcto + msd land in PR-6.2). The endpoint derives `ownerService` from this — only Sage tokens can register personas claiming `ownerService: "sage"`.
2. **Workspace API token** — issued via the workforce CLI's normal session flow. `source: "token"`. The endpoint refuses any persona payload with a non-null `ownerService` (standalone personas only).

Cross-service registration is rejected with `403 cross_service_registration_forbidden`.

## Request shape

```http
POST /api/v1/personas/register
Authorization: Bearer <token>
Content-Type: application/json

{
  "source": "sage@1.5.41",
  "workspaceIds": ["ws_optional_array"],
  "personas": [
    {
      "id": "sage:morning-briefing",
      "intent": "morning-briefing",
      "description": "Daily 7am summary",
      "ownerService": "sage",
      "executor": {
        "kind": "http-delegate",
        "router": {
          "kind": "workerd-service",
          "url": "https://sage.agentrelay.com/api/proactive/dispatch",
          "auth": { "kind": "shared-secret", "envVar": "SAGE_CLOUD_API_TOKEN" },
          "timeoutSeconds": 20
        }
      }
    }
  ]
}
```

`workspaceIds` is optional. When omitted, registrations land in the caller token's bound workspace. When provided, the endpoint registers each persona into every listed workspace (membership check is a PR-1.3 follow-up; the current cut trusts the caller to only pass workspaces they own).

## Response shape

```json
{
  "source": "sage@1.5.41",
  "results": [
    { "id": "sage:morning-briefing", "status": "registered", "agentId": "agt_..." },
    { "id": "sage:follow-up-sweep", "status": "unchanged", "agentId": "agt_..." }
  ]
}
```

## Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid_body` | Body wasn't valid JSON. |
| 400 | `invalid_payload` | Payload missing required fields per canonical-spec §7.1. |
| 401 | `unauthenticated` | No bearer token. |
| 403 | `cross_service_registration_forbidden` | Token's identity ≠ persona's claimed `ownerService`. |
| 429 | `rate_limited` | Per-token register requests > 60 in the last 60 seconds. |

## Operator verification

After deploying a worker that calls `/personas/register` at boot, verify the registration landed:

```sql
SELECT id, deployed_name, owner_service, source_tag, executor
FROM agents
WHERE workspace_id = '<workspace-id>'
ORDER BY updated_at DESC
LIMIT 10;
```

Each registered persona should show its `owner_service` (or NULL for workspace-token standalone), the latest `source_tag`, and the JSON `executor` matching what the worker shipped.

## What's deferred to follow-up PRs

- **First-time agent row creation**: covered by PR-1.3. For now, deploy via the existing CLI to get the `agents` row, then re-register to set `executor`.
- **`executor.kind` branching in the dispatcher**: PR-2.1 — until then, all agents run via the existing ephemeral-sandbox pathway regardless of what `executor` says.
- **Multi-workspace membership check**: PR-1.3.
- **Redis-backed rate limiting**: the current in-memory bucket is fine for single-instance staging but drops counts across web instances. PR-1.4.
