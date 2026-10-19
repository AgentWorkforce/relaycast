/** Engine domain observations. Hosts decide whether and how to consume them. */
export const ENGINE_OBSERVATION_FACTS = {
  'workspace.created': [],
  'workspace.updated': [],
  'workspace.deleted': [],
  'workspace.stream.updated': ['stream_mode'],
  'agent.registered': ['agent_id'],
  'agent.updated': ['agent_name'],
  'legacy.identity.claimed': ['agent_name'],
  'agent.deleted': ['agent_name'],
  'agent.token.rotated': ['agent_name'],
  'agent.identity.taken.over': ['agent_id', 'agent_name', 'audit_id'],
  'agent.token.revoked': ['agent_id', 'agent_name', 'audit_id'],
  'channel.created': ['channel_id', 'channel_name'],
  'channel.updated': ['channel_id', 'channel_name'],
  'channel.topic.updated': ['channel_id', 'channel_name'],
  'channel.archived': ['channel_name'],
  'channel.joined': ['channel_name', 'agent_id'],
  'channel.left': ['channel_name', 'agent_id'],
  'channel.invited': ['channel_name', 'invited_agent_name'],
  'channel.muted': ['channel_name', 'agent_id'],
  'channel.unmuted': ['channel_name', 'agent_id'],
  'message.created': ['channel_id', 'message_id'],
  'thread.reply.created': ['message_id', 'parent_message_id'],
  'file.upload.requested': ['file_id', 'size_bytes'],
  'file.upload.completed': ['file_id', 'size_bytes'],
  'dm.sent': ['conversation_id', 'message_id'],
  'group.dm.created': ['conversation_id'],
  'group.dm.message.sent': ['conversation_id', 'message_id'],
  'group.dm.participant.added': ['conversation_id', 'agent_name'],
  'group.dm.participant.removed': ['conversation_id', 'agent_id'],
  'reaction.added': ['message_id', 'emoji'],
  'reaction.removed': ['message_id', 'emoji'],
  'search.executed': ['query_length', 'result_count'],
  'command.registered': ['command'],
  'command.deleted': ['command'],
  'command.invoked': ['command', 'invocation_id'],
  'subscription.created': ['subscription_id'],
  'subscription.deleted': ['subscription_id'],
  'inbound.webhook.created': ['webhook_id'],
  'inbound.webhook.deleted': ['webhook_id'],
  'inbound.webhook.triggered': ['webhook_id'],
  'message.read.marked': ['message_id', 'agent_id'],
  'presence.heartbeat': ['agent_id'],
  'presence.disconnected': ['agent_id'],
  'system.prompt.updated': ['operation'],
  'ws.session.started': ['session_scope'],
  'ws.session.ended': ['session_scope', 'duration_ms'],
  'action.registered': ['action_name'],
  'action.deleted': ['action_name'],
  'action.invoked': ['action_name', 'invocation_id'],
  'directory.agent.created': [],
  'directory.agent.updated': ['slug'],
  'directory.agent.deleted': ['slug'],
  'directory.rating.upserted': ['slug', 'score'],
  'directory.search.executed': ['result_count'],
  'route.resolved': ['skill'],
  'route.feedback.recorded': ['agent_name', 'success'],
  'routing.config.updated': [],
  'relayfile.inbound.delivered': ['provider'],
} as const;
export type EngineObservationKind = keyof typeof ENGINE_OBSERVATION_FACTS;
export type EngineObservationFacts<K extends EngineObservationKind> = Record<string, unknown> & {
  [F in (typeof ENGINE_OBSERVATION_FACTS)[K][number]]: string | number | boolean | null;
};
interface ObservationFor<K extends EngineObservationKind> {
  kind: K;
  occurredAt: string;
  workspaceId: string;
  /** Credential-authenticated principal only. Internal proof: never export this hash. */
  authenticatedActor?: { agentId: string; credentialHash?: string; type: 'human' | 'agent' | 'system' };
  /** Domain sender, which may differ from the authenticated principal (node posting as). */
  sender?: { id: string; name: string; type: 'human' | 'agent' | 'system' };
  origin: { actor: string; client: string; version: string };
  facts: EngineObservationFacts<K>;
}
export type EngineObservation<K extends EngineObservationKind = EngineObservationKind> = K extends EngineObservationKind ? ObservationFor<K> : never;
export type TelemetryEvent = EngineObservation;
export interface TelemetrySink {
  capture(event: EngineObservation): void | Promise<void>;
  captureException(err: unknown, context?: Record<string, unknown>): void | Promise<void>;
}

/** Isolate every host callback, including error reporting and maintenance paths. */
export function safeTelemetrySink(sink: TelemetrySink): TelemetrySink {
  const invoke = (callback: () => void | Promise<void>) => {
    try { const pending = callback(); if (pending) void Promise.resolve(pending).catch(() => {}); } catch { /* best effort */ }
  };
  return {
    capture: (event) => invoke(() => sink.capture(event)),
    captureException: (error, context) => invoke(() => sink.captureException(error, context)),
  };
}
