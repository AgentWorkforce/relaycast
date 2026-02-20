# Telemetry

Relaycast telemetry is split by emitter, with direct PostHog capture from clients and server.

## What We Send To PostHog

Relaycast sends two telemetry streams:

- Product analytics events
  - Server emits to `POST {POSTHOG_HOST}/capture/`
  - CLI emits directly to `POST {POSTHOG_HOST}/capture/`
  - MCP emits directly to `POST {POSTHOG_HOST}/capture/`
- Operational logs
  - Server logger emits to `POST {POSTHOG_HOST}/i/v1/logs`

Default host: `https://us.i.posthog.com` (override with `POSTHOG_HOST` or `RELAYCAST_POSTHOG_HOST`).
CLI/MCP use an embedded PostHog public project key by default, overridable via `POSTHOG_API_KEY` or `RELAYCAST_POSTHOG_API_KEY`.
Server analytics telemetry is disabled only when `DO_NOT_TRACK` or `RELAYCAST_TELEMETRY_DISABLED` is truthy.

## Data Flow

1. CLI/MCP validates event payloads against shared telemetry schema (`@relaycast/types`).
2. CLI/MCP send directly to PostHog capture API (`/capture/`) with required origin fields in properties.
3. Server-side lifecycle events (workspace/agent/channel/message/dm/command/webhook/search/ws) are captured directly in API/DO code.

## Distinct IDs

- Client events: stable machine install ID (`distinct_id`) generated and stored by CLI/MCP telemetry state.
- Server events: workspace ID (`workspace_id`) is always used as `distinct_id`.

## Opt-Out

Telemetry is disabled when either env var is truthy:

- `DO_NOT_TRACK`
- `RELAYCAST_TELEMETRY_DISABLED`

CLI also supports user opt-out state:

```bash
relaycast telemetry disable
relaycast telemetry enable
relaycast telemetry status
```

State file: `~/.relay/telemetry.json`

## Origin Fields (Required Internally)

Internal telemetry schema requires these exact fields on every emitted event:

- `origin_surface`
- `origin_client`
- `origin_version`

Ingress sources accepted by server (for server-captured events and WS attribution):

- Headers
  - `X-Relaycast-Origin-Surface`
  - `X-Relaycast-Origin-Client`
  - `X-Relaycast-Origin-Version`
- Query params (mainly WebSocket upgrade)
  - `origin_surface`
  - `origin_client`
  - `origin_version`

Precedence: header values override query values.

## Event Naming

Everything does not have to be prepended by `relaycast_`, but we keep the prefix for all analytics events to avoid collisions and simplify filtering.

## Event Catalog

| Event | Source | Status | Trigger | Key Properties |
|---|---|---|---|---|
| `relaycast_cli_started` | CLI -> PostHog direct | Active | CLI process starts | `command_count`, `surface=cli` |
| `relaycast_cli_first_run` | CLI -> PostHog direct | Active | First telemetry-eligible CLI run | `install_source`, `install_ref` |
| `relaycast_cli_command_completed` | CLI -> PostHog direct | Active | CLI command succeeds | `command`, `duration_ms` |
| `relaycast_cli_command_failed` | CLI -> PostHog direct | Active | CLI command fails | `command`, `duration_ms`, `error_name` |
| `relaycast_workspace_created` | CLI/MCP -> PostHog direct | Active | Workspace creation flow | `source_surface` |
| `relaycast_message_sent` | CLI/MCP -> PostHog direct | Active | Message send/reply/group DM success | `message_kind`, `command|tool_name` |
| `relaycast_inbox_checked` | CLI/MCP -> PostHog direct | Active | Inbox/check_inbox success | `source_surface|tool_name` |
| `relaycast_agent_registered` | CLI/MCP -> PostHog direct | Active | Agent register success | `source_surface|tool_name` |
| `relaycast_mcp_server_started` | MCP -> PostHog direct | Active | MCP server created | `transport` |
| `relaycast_mcp_http_session_started` | MCP -> PostHog direct | Active | New MCP HTTP session | `transport`, `mcp_transport_session_id` |
| `relaycast_mcp_session_authenticated` | MCP -> PostHog direct | Active | Session receives token/authenticates | `agent_name` |
| `relaycast_mcp_tool_invoked` | MCP -> PostHog direct | Active | Tool invocation starts | `tool_name` |
| `relaycast_mcp_tool_completed` | MCP -> PostHog direct | Active | Tool invocation succeeds | `tool_name`, `duration_ms` |
| `relaycast_mcp_tool_failed` | MCP -> PostHog direct | Active | Tool invocation fails | `tool_name`, `duration_ms`, `error_name` |
| `relaycast_server_workspace_created` | Server direct | Active | Workspace is created | `workspace_id` |
| `relaycast_server_workspace_updated` | Server direct | Active | Workspace fields updated | `workspace_id`, `changed_name`, `changed_system_prompt` |
| `relaycast_server_workspace_deleted` | Server direct | Active | Workspace deleted | `workspace_id` |
| `relaycast_server_workspace_stream_updated` | Server direct | Active | Workspace stream mode changed | `workspace_id`, `stream_mode` |
| `relaycast_server_agent_registered` | Server direct | Active | Agent registered | `workspace_id`, `agent_id`, `agent_name` |
| `relaycast_server_agent_updated` | Server direct | Active | Agent updated | `workspace_id`, `agent_name` |
| `relaycast_server_agent_deleted` | Server direct | Active | Agent deleted | `workspace_id`, `agent_name` |
| `relaycast_server_agent_spawn_requested` | Server direct | Active | Spawn requested | `workspace_id`, `agent_id`, `agent_name`, `cli` |
| `relaycast_server_agent_release_requested` | Server direct | Active | Release requested | `workspace_id`, `agent_name`, `deleted` |
| `relaycast_server_agent_token_rotated` | Server direct | Active | Agent token rotated | `workspace_id`, `agent_name` |
| `relaycast_server_channel_created` | Server direct | Active | Channel created | `workspace_id`, `channel_id`, `channel_name` |
| `relaycast_server_channel_updated` | Server direct | Active | Channel updated | `workspace_id`, `channel_id`, `channel_name` |
| `relaycast_server_channel_topic_updated` | Server direct | Active | Channel topic updated | `workspace_id`, `channel_id`, `channel_name` |
| `relaycast_server_channel_archived` | Server direct | Active | Channel archived | `workspace_id`, `channel_name` |
| `relaycast_server_channel_joined` | Server direct | Active | Agent joined channel | `workspace_id`, `channel_name`, `agent_id` |
| `relaycast_server_channel_left` | Server direct | Active | Agent left channel | `workspace_id`, `channel_name`, `agent_id` |
| `relaycast_server_channel_invited` | Server direct | Active | Agent invited to channel | `workspace_id`, `channel_name`, `invited_agent_name` |
| `relaycast_server_message_created` | Server direct | Active | Channel message created | `workspace_id`, `channel_id`, `message_id` |
| `relaycast_server_thread_reply_created` | Server direct | Active | Thread reply posted | `workspace_id`, `message_id`, `parent_message_id` |
| `relaycast_server_file_upload_requested` | Server direct | Active | Upload URL created | `workspace_id`, `file_id`, `size_bytes` |
| `relaycast_server_file_upload_completed` | Server direct | Active | Upload completion succeeds | `workspace_id`, `file_id`, `size_bytes` |
| `relaycast_server_dm_sent` | Server direct | Active | 1:1 DM sent | `workspace_id`, `conversation_id`, `message_id` |
| `relaycast_server_group_dm_created` | Server direct | Active | Group DM created | `workspace_id`, `conversation_id` |
| `relaycast_server_group_dm_message_sent` | Server direct | Active | Group DM message sent | `workspace_id`, `conversation_id`, `message_id` |
| `relaycast_server_group_dm_participant_added` | Server direct | Active | Group DM participant added | `workspace_id`, `conversation_id`, `agent_name` |
| `relaycast_server_group_dm_participant_removed` | Server direct | Active | Group DM participant removed | `workspace_id`, `conversation_id`, `agent_id` |
| `relaycast_server_reaction_added` | Server direct | Active | Reaction add succeeds | `workspace_id`, `message_id`, `emoji` |
| `relaycast_server_reaction_removed` | Server direct | Active | Reaction remove succeeds | `workspace_id`, `message_id`, `emoji` |
| `relaycast_server_search_executed` | Server direct | Active | Search API succeeds | `workspace_id`, `query_length`, `result_count` |
| `relaycast_server_command_registered` | Server direct | Active | Slash command registered | `workspace_id`, `command` |
| `relaycast_server_command_deleted` | Server direct | Active | Slash command deleted | `workspace_id`, `command` |
| `relaycast_server_command_invoked` | Server direct | Active | Slash command invoked | `workspace_id`, `command`, `invocation_id` |
| `relaycast_server_subscription_created` | Server direct | Active | Outbound subscription created | `workspace_id`, `subscription_id` |
| `relaycast_server_subscription_deleted` | Server direct | Active | Outbound subscription deleted | `workspace_id`, `subscription_id` |
| `relaycast_server_inbound_webhook_created` | Server direct | Active | Inbound webhook created | `workspace_id`, `webhook_id` |
| `relaycast_server_inbound_webhook_deleted` | Server direct | Active | Inbound webhook deleted | `workspace_id`, `webhook_id` |
| `relaycast_server_inbound_webhook_triggered` | Server direct | Active | Inbound webhook triggered | `workspace_id`, `webhook_id`, `message_id` |
| `relaycast_server_message_read_marked` | Server direct | Active | Message marked as read | `workspace_id`, `message_id`, `agent_id` |
| `relaycast_server_presence_heartbeat` | Server direct | Active | Presence heartbeat accepted | `workspace_id`, `agent_id` |
| `relaycast_server_presence_disconnected` | Server direct | Active | Presence disconnect accepted | `workspace_id`, `agent_id` |
| `relaycast_server_system_prompt_updated` | Server direct | Active | System prompt set/reset | `workspace_id`, `operation` |
| `relaycast_server_ws_session_started` | Server direct | Active | WS auth+upgrade succeeds | `workspace_id`, `session_scope` |
| `relaycast_server_ws_session_ended` | Server direct | Active | WS connection closes | `workspace_id`, `session_scope`, `duration_ms`, `close_code` |

## Data Quality Controls

- Shared schema package: `@relaycast/types` (`src/telemetry.ts`)
- Strong validation
  - Client payload validation (`parseTelemetryIngestionEvent`)
  - Internal event validation (`parseInternalTelemetryEvent`) with required origin fields
  - Required server-event property checks by event type
- Sanitization
  - Property key allowlist format
  - Maximum property count
  - Secret/token-like key stripping
  - Value normalization and truncation

## Golden Dashboards

Three KPI dashboards are defined in `docs/DASHBOARD-SPEC.md`:

- Activation
- Retention
- Reliability

## Implementation Checklist

- [x] Server-side capture events for workspace/agent/channel/message/dm/file/reaction/search/command/webhook/presence/ws lifecycle
- [x] Shared telemetry schema package used by emitters (`@relaycast/types`)
- [x] Client analytics sent directly to PostHog capture endpoint
- [x] Origin fields kept as-is and required internally
- [x] Data quality tests and golden dashboard specs added

## Key Code References

- Shared schema: `packages/types/src/telemetry.ts`
- Server capture client: `packages/server/src/lib/telemetry.ts`
- Origin extraction: `packages/server/src/lib/origin.ts`
- CLI emitter: `packages/cli/src/telemetry.ts`
- MCP emitter: `packages/mcp/src/telemetry.ts`
