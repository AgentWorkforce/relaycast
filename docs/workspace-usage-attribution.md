# Workspace usage attribution

Workspace provenance is recorded in the workspace insert so an operator can
separate internal fleet traffic from external use without inspecting agent
names. It is observability only; billing, pricing, invoicing, authentication,
and authorization are outside this contract.

## Creation record

`POST /v1/workspaces` accepts:

```json
{
  "name": "package-validation",
  "provenance": {
    "source": "ci",
    "origin_id": "github:AgentWorkforce/relay/actions/runs/123456",
    "classification": "internal"
  }
}
```

The server stores that declaration with a sanitized snapshot of the existing
origin-actor and Agent Relay user, machine, and organization headers. When an
older client omits `provenance`, the server derives `sdk`, `mcp`, or `cli` from a
known origin-client header where possible and otherwise records `api`. An
explicit internal/external classification is marked `creator`; an absent or
`unknown` classification remains `unclassified`.

Workspace-key reads return the complete creation snapshot. Observer-token reads
omit request actor, user, machine, and organization identity fields.

This changes the existing workspace insert and adds **zero additional writes**
per creation. It adds **zero writes per message**.

## Hosted operator view

The hosted gateway exposes two routes guarded by its existing
`RELAYCAST_INTERNAL_SECRET` bearer:

- `GET /internal/usage/workspaces?classification=external&sort=messages`
- `PATCH /internal/usage/workspaces/{id}/classification`

The list supports `classification`, `source`, `workspace_id`, `sort`, `limit`,
and `offset`. It defaults to `classification=external`; requesting `all` is an
explicit operator choice because an unfiltered ranking is dominated by the
internal and unknown fleet today.
Each row reports message, agent, channel, and file counts; an estimated storage
footprint; first and last user activity; creation provenance; and classification
evidence. `storage_bytes_estimate` is message body/blocks/metadata bytes plus
declared file object bytes. It is not physical D1/R2 allocation and excludes
indexes, delivery ledgers, event logs, and storage overhead.

The list performs one read-time aggregate over the selected workspaces and the
messages, agents, channels, and files that belong to them. Cost is proportional
to those selected rows; an unfiltered all-workspace ranking is intentionally an
operator action, not a request-path query. It performs no writes. A manual
classification is one explicit workspace-row write with a required reason.

## Historical boundary

The migration leaves every existing workspace as:

```text
provenance = NULL
usage_classification = unknown
classification_source = unclassified
```

That is deliberate. For the existing fleet, one can infer:

- `relay-<8 hex>` likely came from the legacy Agent Relay broker generator;
- names such as `cloud-<issue>` or `ar-<issue>` and known machine/agent names can
  suggest internal test traffic;
- activity counts and dates can identify active versus abandoned workspaces.

One cannot infer the creator account, organization, machine, intent, or
internal/external status with certainty. The hosted response therefore returns
legacy name-pattern evidence as `legacy_inference`, separate from
`classification`. An operator may verify a workspace and record a reasoned
classification; the service never writes an inference as historical fact.

## Rollout seam

1. Release the Relaycast engine/types/SDK contract.
2. Apply D1 migration `0039_workspace_usage_attribution.sql` after the workspace
   lifecycle and session-replay migrations and before deploying an
   engine that writes the new columns.
3. Deploy the hosted usage routes and bump the hosted engine package.
4. Update high-volume creators to send precise provenance: CI run ids,
   relayflow/cloud workspace ids, dashboard account context, and CLI origin ids.

The usage view is the seam for a future metering system: it provides attributable
dimensions and quantities. Any decision about billable events, free allowances,
prices, invoices, or enforcement belongs downstream and must not treat
caller-declared classification as a trust boundary.
