import { stableRelaycastEventId } from './event-id.js';

export type WsEvent = {
  type: string;
  workspace_id: string;
  channel_id?: string;
  data: Record<string, unknown>;
  timestamp: string;
};

/**
 * Transform an internal WsEvent into the ServerEvent shape defined in @relaycast/types.
 * This strips internal fields (workspace_id, channel_id, timestamp) and reshapes
 * the `data` bag into the canonical typed event format that clients expect.
 */
export function transformForClient(event: WsEvent): Record<string, unknown> {
  const d = event.data;
  const createdAt = typeof d.created_at === 'string' ? d.created_at : event.timestamp;
  const withCreatedAt = { created_at: createdAt };
  const agentId = (typeof d.agent_id === 'string' ? d.agent_id : null)
    ?? (typeof d.subject_agent_id === 'string' ? d.subject_agent_id : null);
  const agentRef = { ...(agentId ? { id: agentId } : {}), name: d.agent_name as string };

  switch (event.type) {
    case 'message.created':
      return {
        id: stableRelaycastEventId(d.id as string),
        type: 'message.created',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        channel: d.channel_name as string,
        message: {
          id: d.id as string,
          agent_id: d.agent_id as string,
          agent_name: d.from_name as string,
          text: d.text as string,
          attachments: (d.attachments as unknown[]) ?? [],
          injection_mode: d.injection_mode as 'wait' | 'steer' | undefined,
        },
      };

    case 'message.updated':
      return {
        type: 'message.updated',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        channel: d.channel_name as string,
        message: {
          id: d.id as string,
          agent_id: d.agent_id as string,
          agent_name: d.from_name as string,
          text: d.text as string,
        },
      };

    case 'thread.reply':
      return {
        id: stableRelaycastEventId(d.id as string),
        type: 'thread.reply',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        ...(d.conversation_id ? { conversation_id: d.conversation_id as string } : {}),
        channel: d.channel_name as string,
        parent_id: d.thread_id as string,
        message: {
          id: d.id as string,
          agent_id: d.agent_id as string,
          agent_name: d.from_name as string,
          text: d.text as string,
        },
      };

    case 'message.reacted':
      return {
        type: 'message.reacted',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        ...(d.channel_name ? { channel: d.channel_name as string } : {}),
        ...(d.conversation_id ? { conversation_id: d.conversation_id as string } : {}),
        message_id: d.message_id as string,
        emoji: d.emoji as string,
        ...(d.agent_id ? { agent_id: d.agent_id as string } : {}),
        agent_name: d.agent_name as string,
        action: (d.action as string | undefined) ?? 'added',
      };

    case 'dm.received': {
      const msg = (d.message as Record<string, unknown> | undefined) ?? {};
      const injectionMode = (msg.injection_mode ?? d.injection_mode) as 'wait' | 'steer' | undefined;
      const attachments = (msg.attachments ?? d.attachments ?? []) as unknown[];
      return {
        id: stableRelaycastEventId((msg.id ?? d.id) as string),
        type: 'dm.received',
        ...withCreatedAt,
        conversation_id: d.conversation_id as string,
        message: {
          id: (msg.id ?? d.id) as string,
          agent_id: (msg.agent_id ?? d.from_agent_id ?? d.agent_id) as string,
          agent_name: (msg.agent_name ?? d.from_name) as string,
          text: (msg.text ?? d.text) as string,
          ...(injectionMode ? { injection_mode: injectionMode } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
      };
    }

    case 'group_dm.received': {
      const msg = (d.message as Record<string, unknown> | undefined) ?? {};
      const injectionMode = (msg.injection_mode ?? d.injection_mode) as 'wait' | 'steer' | undefined;
      const attachments = (msg.attachments ?? d.attachments ?? []) as unknown[];
      return {
        id: stableRelaycastEventId((msg.id ?? d.id) as string),
        type: 'group_dm.received',
        ...withCreatedAt,
        conversation_id: d.conversation_id as string,
        message: {
          id: (msg.id ?? d.id) as string,
          agent_id: (msg.agent_id ?? d.agent_id) as string,
          agent_name: (msg.agent_name ?? d.from_name) as string,
          text: (msg.text ?? d.text) as string,
          ...(injectionMode ? { injection_mode: injectionMode } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
      };
    }

    case 'agent.status.active':
      return {
        type: 'agent.status.active',
        ...withCreatedAt,
        agent: agentRef,
        status: 'active',
      };

    case 'agent.status.offline':
      return {
        type: 'agent.status.offline',
        ...withCreatedAt,
        agent: agentRef,
        status: 'offline',
      };

    case 'agent.status.changed':
      return {
        type: 'agent.status.changed',
        ...withCreatedAt,
        agent: agentRef,
        status: d.status as string,
      };

    case 'agent.status.idle':
      return {
        type: 'agent.status.idle',
        ...withCreatedAt,
        agent: agentRef,
        status: 'idle',
      };

    case 'agent.status.blocked':
      return {
        type: 'agent.status.blocked',
        ...withCreatedAt,
        agent: agentRef,
        status: 'blocked',
      };

    case 'agent.status.waiting':
      return {
        type: 'agent.status.waiting',
        ...withCreatedAt,
        agent: agentRef,
        status: 'waiting',
      };

    case 'channel.created':
      return {
        type: 'channel.created',
        ...withCreatedAt,
        ...(event.channel_id || d.id ? { channel_id: (event.channel_id ?? d.id) as string } : {}),
        channel: { name: (d.channel_name as string) ?? (d.name as string), topic: (d.topic as string | null) ?? null },
      };

    case 'channel.updated':
      return {
        type: 'channel.updated',
        ...withCreatedAt,
        ...(event.channel_id || d.id ? { channel_id: (event.channel_id ?? d.id) as string } : {}),
        channel: { name: (d.channel_name as string) ?? (d.name as string), topic: (d.topic as string | null) ?? null },
      };

    case 'channel.archived':
      return {
        type: 'channel.archived',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        channel: { name: d.channel_name as string },
      };

    case 'member.joined':
      return {
        type: 'member.joined',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        channel: d.channel_name as string,
        ...(d.agent_id ? { agent_id: d.agent_id as string } : {}),
        agent_name: d.agent_name as string,
      };

    case 'member.left':
      return {
        type: 'member.left',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        channel: d.channel_name as string,
        ...(d.agent_id ? { agent_id: d.agent_id as string } : {}),
        agent_name: d.agent_name as string,
      };

    case 'message.read':
      return {
        type: 'message.read',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        message_id: d.message_id as string,
        ...(d.conversation_id ? { conversation_id: d.conversation_id as string } : {}),
        ...(d.agent_id ? { agent_id: d.agent_id as string } : {}),
        agent_name: d.agent_name as string,
        read_at: d.read_at as string,
      };

    case 'file.uploaded':
      return {
        type: 'file.uploaded',
        ...withCreatedAt,
        ...(d.agent_id ? { agent_id: d.agent_id as string } : {}),
        file: {
          file_id: (d.file_id as string) ?? (d.id as string),
          filename: d.filename as string,
          uploaded_by: (d.uploaded_by as string) ?? (d.agent_id as string),
        },
      };

    case 'webhook.received':
      return {
        type: 'webhook.received',
        ...withCreatedAt,
        ...(event.channel_id ? { channel_id: event.channel_id } : {}),
        webhook_id: d.webhook_id as string,
        channel: d.channel as string,
        message: {
          id: d.message_id as string,
          text: d.text as string,
          source: (d.source as string | null) ?? null,
          author: (d.author as string | null) ?? null,
        },
      };

    case 'command.invoked':
      return {
        type: 'command.invoked',
        ...withCreatedAt,
        command: d.command as string,
        channel: d.channel as string,
        invoked_by: d.invoked_by as string,
        handler_agent_id: d.handler_agent_id as string,
        args: (d.args as string | null) ?? null,
        parameters: (d.parameters as Record<string, unknown> | null) ?? null,
      };

    default: {
      const { workspace_id: _workspace_id, channel_id: _channel_id, timestamp: _timestamp, data, ...rest } = event as WsEvent & Record<string, unknown>;
      return { ...rest, ...data, ...withCreatedAt };
    }
  }
}
