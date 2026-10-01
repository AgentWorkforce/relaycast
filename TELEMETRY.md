# Telemetry

Relaycast collects anonymous product telemetry to understand feature usage and reliability.

## What We Collect

Relaycast sends telemetry to PostHog for:

- Product usage analytics
- Reliability and operational diagnostics

Telemetry payloads can include event names, anonymous identifiers, runtime metadata (for example platform and version), and sanitized properties.

## What We Avoid Collecting

Telemetry is designed to avoid sensitive data:

- Property sanitization removes common secret-like keys (`token`, `api_key`, `secret`, `password`, `authorization`)
- Property keys and values are constrained and normalized
- Events are schema-validated in `@relaycast/types`

## Where Data Is Sent

Telemetry is sent to PostHog.

Default host: `https://us.i.posthog.com`

Host and authentication can be configured through environment settings.

## How To Disable Telemetry

Set either environment variable:

- `DO_NOT_TRACK=1`
- `RELAYCAST_TELEMETRY_DISABLED=1`

## Identifiers

Client telemetry uses anonymous identifiers.

### Server events: person

`emitServerEvent` picks each server event's `distinct_id` in this order:

1. The acting agent's `metadata.cloud_user_id`. For a human agent this is the human; for any other agent it is the agent's owner.
2. The caller-declared user (`X-Agent-Relay-User-Id`), then the client id (`X-Agent-Relay-Distinct-Id`).
3. `relaycast-ws:<workspace_id>`, sent with `$process_person_profile: false`. A workspace is never a person.

The acting agent is the agent token's agent. A node token posting a channel message acts as its `from` agent. Context rows from another workspace are ignored.

### Server events: sender

Events with an acting agent carry:

| Property | Value |
|---|---|
| `sender_type` | `human` when `agents.type = 'human'`, else `agent` or `system` |
| `agent_id` | acting agent id |
| `agent_name` | acting agent name |
| `agent_owner_user_id` | owner's `cloud_user_id`, only when the actor is not a human |

An event's own `agent_id`/`agent_name` (for example the subject of `relaycast_server_channel_joined`) takes precedence over the sender's.

Send events (`relaycast_server_message_created`, `relaycast_server_thread_reply_created`, `relaycast_server_dm_sent`, `relaycast_server_group_dm_message_sent`) set `$set_once` on the person:

- `first_human_message_at` when a human sends
- `first_agent_message_at` when an agent (`sender_type: agent`) with an owner sends

### Server events: groups

`$groups: { organization, workspace }` come from `workspaces.metadata.cloud_org_id` and `workspaces.metadata.cloud_workspace_id`, which cloud writes. Each group is set only when its id is present; with neither, `$groups` is absent. Emitters without an authenticated workspace (inbound webhooks, Relayfile inbound, node sockets) load the workspace row to resolve them.

The engine passes these on `TelemetryEvent` as `groups`, `setOnce` and `processPersonProfile`; the sink maps them to PostHog's `$groups`, `$set_once` and `$process_person_profile`.

## Best-Effort Delivery

Telemetry delivery is best-effort:

- Request failures are swallowed
- Telemetry does not block normal operation

## Code References

- `packages/types/src/telemetry.ts`
- `packages/mcp/src/telemetry.ts`
- `packages/engine/src/lib/serverTelemetry.ts`
