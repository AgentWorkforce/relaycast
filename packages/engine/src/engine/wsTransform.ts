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

  switch (event.type) {
    case 'message.created':
      return {
        id: stableRelaycastEventId(d.id as string),
        type: 'message.created',
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
        message_id: d.message_id as string,
        emoji: d.emoji as string,
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
        agent: { name: d.agent_name as string },
        status: 'active',
      };

    case 'agent.status.offline':
      return {
        type: 'agent.status.offline',
        agent: { name: d.agent_name as string },
        status: 'offline',
      };

    case 'agent.status.changed':
      return {
        type: 'agent.status.changed',
        agent: { name: d.agent_name as string },
        status: d.status as string,
      };

    case 'agent.status.idle':
      return {
        type: 'agent.status.idle',
        agent: { name: d.agent_name as string },
        status: 'idle',
      };

    case 'agent.status.blocked':
      return {
        type: 'agent.status.blocked',
        agent: { name: d.agent_name as string },
        status: 'blocked',
      };

    case 'agent.status.waiting':
      return {
        type: 'agent.status.waiting',
        agent: { name: d.agent_name as string },
        status: 'waiting',
      };

    case 'agent.spawn_requested':
      return {
        type: 'agent.spawn_requested',
        agent: {
          name: d.agent_name as string,
          cli: d.cli as string,
          task: d.task as string,
          channel: (d.channel as string | null) ?? null,
          model: (d.model as string | null) ?? null,
          already_existed: d.already_existed as boolean,
        },
      };

    case 'agent.release_requested':
      return {
        type: 'agent.release_requested',
        agent: { name: d.agent_name as string },
        reason: (d.reason as string | null) ?? null,
        deleted: d.deleted as boolean,
      };

    case 'channel.created':
      return {
        type: 'channel.created',
        channel: { name: (d.channel_name as string) ?? (d.name as string), topic: (d.topic as string | null) ?? null },
      };

    case 'channel.updated':
      return {
        type: 'channel.updated',
        channel: { name: (d.channel_name as string) ?? (d.name as string), topic: (d.topic as string | null) ?? null },
      };

    case 'channel.archived':
      return {
        type: 'channel.archived',
        channel: { name: d.channel_name as string },
      };

    case 'member.joined':
      return {
        type: 'member.joined',
        channel: d.channel_name as string,
        agent_name: d.agent_name as string,
      };

    case 'member.left':
      return {
        type: 'member.left',
        channel: d.channel_name as string,
        agent_name: d.agent_name as string,
      };

    case 'message.read':
      return {
        type: 'message.read',
        message_id: d.message_id as string,
        agent_name: d.agent_name as string,
        read_at: d.read_at as string,
      };

    case 'file.uploaded':
      return {
        type: 'file.uploaded',
        file: {
          file_id: (d.file_id as string) ?? (d.id as string),
          filename: d.filename as string,
          uploaded_by: (d.uploaded_by as string) ?? (d.agent_id as string),
        },
      };

    case 'webhook.received':
      return {
        type: 'webhook.received',
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
        command: d.command as string,
        channel: d.channel as string,
        invoked_by: d.invoked_by as string,
        handler_agent_id: d.handler_agent_id as string,
        args: (d.args as string | null) ?? null,
        parameters: (d.parameters as Record<string, unknown> | null) ?? null,
      };

    default: {
      const { workspace_id: _workspace_id, channel_id: _channel_id, timestamp: _timestamp, data, ...rest } = event as WsEvent & Record<string, unknown>;
      return { ...rest, ...data };
    }
  }
}
