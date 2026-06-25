import { z } from 'zod';

const TELEMETRY_MAX_PROPERTIES = 64;
const TELEMETRY_VALUE_MAX_LENGTH = 512;

const telemetryString = (max: number) => z.string().trim().min(1).max(max);
const telemetryKeySchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);

export const telemetryOriginSchema = z.object({
  origin_client: telemetryString(80),
  origin_version: telemetryString(48),
});

export type TelemetryOrigin = z.infer<typeof telemetryOriginSchema>;

export const CLIENT_TELEMETRY_EVENTS = [
  'relaycast_cli_started',
  'relaycast_cli_first_run',
  'relaycast_cli_command_completed',
  'relaycast_cli_command_failed',
  'relaycast_workspace_created',
  'relaycast_message_sent',
  'relaycast_inbox_checked',
  'relaycast_agent_registered',
  'relaycast_mcp_server_started',
  'relaycast_mcp_http_session_started',
  'relaycast_mcp_session_authenticated',
  'relaycast_mcp_tool_invoked',
  'relaycast_mcp_tool_completed',
  'relaycast_mcp_tool_failed',
] as const;

export const SERVER_TELEMETRY_EVENTS = [
  'relaycast_server_workspace_created',
  'relaycast_server_workspace_updated',
  'relaycast_server_workspace_deleted',
  'relaycast_server_workspace_stream_updated',
  'relaycast_server_agent_registered',
  'relaycast_server_agent_updated',
  'relaycast_server_agent_deleted',
  'relaycast_server_agent_token_rotated',
  'relaycast_server_channel_created',
  'relaycast_server_channel_updated',
  'relaycast_server_channel_topic_updated',
  'relaycast_server_channel_archived',
  'relaycast_server_channel_joined',
  'relaycast_server_channel_left',
  'relaycast_server_channel_invited',
  'relaycast_server_message_created',
  'relaycast_server_thread_reply_created',
  'relaycast_server_file_upload_requested',
  'relaycast_server_file_upload_completed',
  'relaycast_server_dm_sent',
  'relaycast_server_group_dm_created',
  'relaycast_server_group_dm_message_sent',
  'relaycast_server_group_dm_participant_added',
  'relaycast_server_group_dm_participant_removed',
  'relaycast_server_reaction_added',
  'relaycast_server_reaction_removed',
  'relaycast_server_search_executed',
  'relaycast_server_command_registered',
  'relaycast_server_command_deleted',
  'relaycast_server_command_invoked',
  'relaycast_server_subscription_created',
  'relaycast_server_subscription_deleted',
  'relaycast_server_inbound_webhook_created',
  'relaycast_server_inbound_webhook_deleted',
  'relaycast_server_inbound_webhook_triggered',
  'relaycast_server_message_read_marked',
  'relaycast_server_presence_heartbeat',
  'relaycast_server_presence_disconnected',
  'relaycast_server_system_prompt_updated',
  'relaycast_server_ws_session_started',
  'relaycast_server_ws_session_ended',
] as const;

export const TELEMETRY_EVENTS = [
  ...CLIENT_TELEMETRY_EVENTS,
  ...SERVER_TELEMETRY_EVENTS,
] as const;

export type ClientTelemetryEventName = typeof CLIENT_TELEMETRY_EVENTS[number];
export type ServerTelemetryEventName = typeof SERVER_TELEMETRY_EVENTS[number];
export type TelemetryEventName = typeof TELEMETRY_EVENTS[number];

export const clientTelemetryEventSchema = z.enum(CLIENT_TELEMETRY_EVENTS);
export const serverTelemetryEventSchema = z.enum(SERVER_TELEMETRY_EVENTS);
export const telemetryEventSchema = z.enum(TELEMETRY_EVENTS);

export type TelemetryPropertyValue = string | number | boolean | null;

export const telemetryValueSchema = z.union([
  z.string().max(TELEMETRY_VALUE_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const telemetryPropertiesSchema = z
  .record(telemetryKeySchema, telemetryValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > TELEMETRY_MAX_PROPERTIES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Telemetry payload cannot contain more than ${TELEMETRY_MAX_PROPERTIES} properties`,
      });
    }
  });

const telemetryEnvelopeBaseSchema = z.object({
  distinct_id: telemetryString(128),
  properties: telemetryPropertiesSchema.default({}),
});

export const telemetryIngestionEventSchema = telemetryEnvelopeBaseSchema.extend({
  event: clientTelemetryEventSchema,
});

export type TelemetryIngestionEvent = z.infer<typeof telemetryIngestionEventSchema>;

export const internalTelemetryEventSchema = telemetryEnvelopeBaseSchema.extend({
  event: telemetryEventSchema,
}).merge(telemetryOriginSchema);

export type InternalTelemetryEvent = z.infer<typeof internalTelemetryEventSchema>;

const REQUIRED_SERVER_EVENT_PROPS: Record<ServerTelemetryEventName, readonly string[]> = {
  relaycast_server_workspace_created: ['workspace_id'],
  relaycast_server_workspace_updated: ['workspace_id'],
  relaycast_server_workspace_deleted: ['workspace_id'],
  relaycast_server_workspace_stream_updated: ['workspace_id', 'stream_mode'],
  relaycast_server_agent_registered: ['workspace_id', 'agent_id'],
  relaycast_server_agent_updated: ['workspace_id', 'agent_name'],
  relaycast_server_agent_deleted: ['workspace_id', 'agent_name'],
  relaycast_server_agent_token_rotated: ['workspace_id', 'agent_name'],
  relaycast_server_channel_created: ['workspace_id', 'channel_id', 'channel_name'],
  relaycast_server_channel_updated: ['workspace_id', 'channel_id', 'channel_name'],
  relaycast_server_channel_topic_updated: ['workspace_id', 'channel_id', 'channel_name'],
  relaycast_server_channel_archived: ['workspace_id', 'channel_name'],
  relaycast_server_channel_joined: ['workspace_id', 'channel_name', 'agent_id'],
  relaycast_server_channel_left: ['workspace_id', 'channel_name', 'agent_id'],
  relaycast_server_channel_invited: ['workspace_id', 'channel_name', 'invited_agent_name'],
  relaycast_server_message_created: ['workspace_id', 'channel_id', 'message_id'],
  relaycast_server_thread_reply_created: ['workspace_id', 'message_id', 'parent_message_id'],
  relaycast_server_file_upload_requested: ['workspace_id', 'file_id', 'size_bytes'],
  relaycast_server_file_upload_completed: ['workspace_id', 'file_id', 'size_bytes'],
  relaycast_server_dm_sent: ['workspace_id', 'conversation_id', 'message_id'],
  relaycast_server_group_dm_created: ['workspace_id', 'conversation_id'],
  relaycast_server_group_dm_message_sent: ['workspace_id', 'conversation_id', 'message_id'],
  relaycast_server_group_dm_participant_added: ['workspace_id', 'conversation_id', 'agent_name'],
  relaycast_server_group_dm_participant_removed: ['workspace_id', 'conversation_id', 'agent_id'],
  relaycast_server_reaction_added: ['workspace_id', 'message_id', 'emoji'],
  relaycast_server_reaction_removed: ['workspace_id', 'message_id', 'emoji'],
  relaycast_server_search_executed: ['workspace_id', 'query_length', 'result_count'],
  relaycast_server_command_registered: ['workspace_id', 'command'],
  relaycast_server_command_deleted: ['workspace_id', 'command'],
  relaycast_server_command_invoked: ['workspace_id', 'command', 'invocation_id'],
  relaycast_server_subscription_created: ['workspace_id', 'subscription_id'],
  relaycast_server_subscription_deleted: ['workspace_id', 'subscription_id'],
  relaycast_server_inbound_webhook_created: ['workspace_id', 'webhook_id'],
  relaycast_server_inbound_webhook_deleted: ['workspace_id', 'webhook_id'],
  relaycast_server_inbound_webhook_triggered: ['workspace_id', 'webhook_id'],
  relaycast_server_message_read_marked: ['workspace_id', 'message_id', 'agent_id'],
  relaycast_server_presence_heartbeat: ['workspace_id', 'agent_id'],
  relaycast_server_presence_disconnected: ['workspace_id', 'agent_id'],
  relaycast_server_system_prompt_updated: ['workspace_id', 'operation'],
  relaycast_server_ws_session_started: ['workspace_id', 'session_scope'],
  relaycast_server_ws_session_ended: ['workspace_id', 'session_scope', 'duration_ms'],
};

const BLOCKED_PROPERTY_PATTERNS = [
  /token/i,
  /^authorization$/i,
  /secret/i,
  /^api[_-]?key$/i,
  /^password$/i,
];

function normalizeStringValue(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= TELEMETRY_VALUE_MAX_LENGTH) return normalized;
  return normalized.slice(0, TELEMETRY_VALUE_MAX_LENGTH);
}

function coerceTelemetryValue(value: unknown): TelemetryPropertyValue | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = normalizeStringValue(value);
    if (!normalized) return undefined;
    return normalized;
  }
  if (value === undefined) return undefined;

  try {
    const normalized = normalizeStringValue(JSON.stringify(value));
    if (!normalized) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

export function sanitizeTelemetryProperties(
  input: Record<string, unknown> | undefined,
): Record<string, TelemetryPropertyValue> {
  if (!input) return {};

  const output: Record<string, TelemetryPropertyValue> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (Object.keys(output).length >= TELEMETRY_MAX_PROPERTIES) break;

    const key = rawKey.trim().slice(0, 64);
    if (!key) continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) continue;
    if (BLOCKED_PROPERTY_PATTERNS.some((pattern) => pattern.test(key))) continue;

    const coerced = coerceTelemetryValue(rawValue);
    if (coerced === undefined) continue;
    output[key] = coerced;
  }

  return output;
}

export function normalizeTelemetryOrigin(origin: Partial<TelemetryOrigin> | undefined): TelemetryOrigin {
  return {
    origin_client: normalizeStringValue(origin?.origin_client ?? 'unknown').slice(0, 80) || 'unknown',
    origin_version: normalizeStringValue(origin?.origin_version ?? 'unknown').slice(0, 48) || 'unknown',
  };
}

function ensureRequiredServerProperties(event: ServerTelemetryEventName, properties: Record<string, TelemetryPropertyValue>): void {
  const required = REQUIRED_SERVER_EVENT_PROPS[event];
  const missing = required.filter((key) => !(key in properties));
  if (missing.length > 0) {
    throw new Error(`Missing required properties for ${event}: ${missing.join(', ')}`);
  }
}

export function parseTelemetryIngestionEvent(input: unknown): TelemetryIngestionEvent {
  const parsed = telemetryIngestionEventSchema.parse(input);
  const properties = sanitizeTelemetryProperties(parsed.properties);
  return {
    ...parsed,
    properties: telemetryPropertiesSchema.parse(properties),
  };
}

export function parseInternalTelemetryEvent(input: unknown): InternalTelemetryEvent {
  const parsed = internalTelemetryEventSchema.parse(input);
  const normalizedOrigin = normalizeTelemetryOrigin(parsed);
  const properties = telemetryPropertiesSchema.parse(sanitizeTelemetryProperties(parsed.properties));

  if (SERVER_TELEMETRY_EVENTS.includes(parsed.event as ServerTelemetryEventName)) {
    ensureRequiredServerProperties(parsed.event as ServerTelemetryEventName, properties);
  }

  return {
    ...parsed,
    ...normalizedOrigin,
    properties,
  };
}
