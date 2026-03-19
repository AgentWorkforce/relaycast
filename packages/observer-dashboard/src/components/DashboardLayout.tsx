'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEvent, usePresence, useChannels, useWebSocket, useRelay } from '@relaycast/react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ActivityLog } from './ActivityLog';
import { ThreadPanel } from './ThreadPanel';
import { AgentPanel } from './AgentPanel';
import { formatDmLabel } from '../lib/utils';
import type { Agent as ApiAgent, MessageCreatedEvent, DmConversationSummary, WorkspaceDmConversation } from '@relaycast/sdk';

function toSummary(wdc: WorkspaceDmConversation): DmConversationSummary {
  return {
    id: wdc.id,
    type: wdc.type as '1:1' | 'group',
    name: null,
    participants: wdc.participants.map((name) => ({ agentId: '', agentName: name })),
    lastMessage: wdc.lastMessage
      ? { id: '', text: wdc.lastMessage.text, agentId: '', createdAt: wdc.lastMessage.createdAt }
      : null,
    unreadCount: 0,
    createdAt: wdc.lastMessage?.createdAt ?? '',
  };
}

export function DashboardLayout() {
  const relay = useRelay();
  const { agents: rawAgents } = usePresence();
  const { channels } = useChannels({ includeArchived: true });
  const [conversations, setConversations] = useState<DmConversationSummary[]>([]);
  const { status: wsStatus } = useWebSocket();
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [unreadChannelCounts, setUnreadChannelCounts] = useState<Record<string, number>>({});
  const [streamEnabled, setStreamEnabled] = useState<boolean | null>(null);
  const [streamMessage, setStreamMessage] = useState<string>('');
  const [streamPending, setStreamPending] = useState(false);

  // Fetch all workspace DMs and refresh on new DM events
  const fetchDMs = useCallback(() => {
    relay.allDmConversations()
      .then((wdcs) => setConversations(wdcs.map(toSummary)))
      .catch(() => {});
  }, [relay]);

  useEffect(() => { fetchDMs(); }, [fetchDMs]);
  useEvent('dm.received', fetchDMs);
  useEvent('group_dm.received', fetchDMs);

  // Default to first channel if none selected
  useEffect(() => {
    if (!selectedChannel && channels.length > 0) {
      const firstChannel = (channels.find((ch) => !ch.isArchived) ?? channels[0]).name;
      setSelectedChannel(firstChannel);
      setUnreadChannelCounts((prev) =>
        prev[firstChannel] && prev[firstChannel] > 0
          ? { ...prev, [firstChannel]: 0 }
          : prev,
      );
    }
  }, [selectedChannel, channels]);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);

  useEffect(() => {
    const knownChannels = new Set(channels.map((ch) => ch.name));
    setUnreadChannelCounts((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [name, count] of Object.entries(prev)) {
        if (knownChannels.has(name)) {
          next[name] = count;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [channels]);

  useEvent('message.created', (evt) => {
    const event = evt as MessageCreatedEvent;
    const channelName = event.channel;
    if (!channelName) return;

    if (selectedChannel === channelName) {
      return;
    }

    setUnreadChannelCounts((prev) => ({
      ...prev,
      [channelName]: (prev[channelName] ?? 0) + 1,
    }));
  });

  // Filter out dashboard observer identities.
  const mentionableAgents = rawAgents.filter((agent) => !agent.name.startsWith('_dashboard_'));
  const mentionNames = mentionableAgents.map((agent) => agent.name);

  // Filter out stale offline agents (offline > 5 min) from sidebar listings.
  const STALE_OFFLINE_MS = 5 * 60 * 1000;
  const agents = mentionableAgents.filter((a) => {
    if (a.status === 'offline' && a.lastSeen) {
      const elapsed = Date.now() - new Date(a.lastSeen).getTime();
      if (elapsed > STALE_OFFLINE_MS) return false;
    }
    return true;
  });

  const refreshStreamStatus = useCallback(async () => {
    try {
      const data = await relay.workspace.stream.get();
      setStreamEnabled(data.enabled);
      setStreamMessage(data.enabled
        ? ''
        : 'Workspace stream is disabled. Realtime updates will be incomplete.');
    } catch {
      setStreamEnabled(null);
      setStreamMessage('');
    }
  }, [relay]);

  useEffect(() => {
    void refreshStreamStatus();
  }, [refreshStreamStatus]);

  async function handleEnableStream() {
    setStreamPending(true);
    setStreamMessage('');
    try {
      const data = await relay.workspace.stream.set(true);
      setStreamEnabled(data.enabled);
      setStreamMessage('');
    } catch (error) {
      setStreamEnabled(false);
      setStreamMessage(
        error instanceof Error && error.message
          ? error.message
          : 'Failed to enable workspace stream. Please try again.',
      );
    } finally {
      setStreamPending(false);
    }
  }

  function handleSelectAgent(name: string | null) {
    setSelectedAgent(name);
    if (name) setThreadMessageId(null);
  }

  function handleSelectChannel(name: string | null) {
    setSelectedChannel(name);
    setSelectedAgent(null);
    setThreadMessageId(null);
    if (name && !name.startsWith('dm:')) {
      setUnreadChannelCounts((prev) =>
        prev[name] && prev[name] > 0
          ? { ...prev, [name]: 0 }
          : prev,
      );
    }
  }

  // Determine right panel priority: agent panel > thread > activity
  const selectedAgentData: ApiAgent | null = selectedAgent
    ? mentionableAgents.find((a) => a.name === selectedAgent) ?? null
    : null;
  const selectedChannelMemberCount =
    selectedChannel && !selectedChannel.startsWith('dm:')
      ? (channels.find((ch) => ch.name === selectedChannel)?.memberCount ?? 0)
      : null;
  const selectedChannelArchived =
    selectedChannel && !selectedChannel.startsWith('dm:')
      ? (channels.find((ch) => ch.name === selectedChannel)?.isArchived ?? false)
      : false;
  const selectedDmLabel =
    selectedChannel?.startsWith('dm:')
      ? (() => {
          const conversation = conversations.find((dm) => `dm:${dm.id}` === selectedChannel);
          if (!conversation) return undefined;
          return formatDmLabel(conversation.participants, conversation.name);
        })()
      : undefined;

  let rightPanel: React.ReactNode = null;
  if (selectedAgentData) {
    rightPanel = (
      <AgentPanel
        agent={selectedAgentData}
        onClose={() => setSelectedAgent(null)}
      />
    );
  } else if (threadMessageId) {
    rightPanel = (
      <ThreadPanel
        messageId={threadMessageId}
        onClose={() => setThreadMessageId(null)}
        mentionNames={mentionNames}
        onOpenAgent={handleSelectAgent}
      />
    );
  } else {
    rightPanel = <ActivityLog />;
  }

  return (
    <div className="h-screen flex bg-[var(--color-bg-deep)]">
      <AgentSidebar
        channels={channels}
        agents={agents}
        conversations={conversations}
        selectedChannel={selectedChannel}
        selectedAgent={selectedAgent}
        unreadChannelCounts={unreadChannelCounts}
        wsStatus={wsStatus}
        onSelectChannel={handleSelectChannel}
        onSelectAgent={handleSelectAgent}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {streamEnabled === false && (
          <div className="mx-3 mt-3 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-light)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-[var(--color-warning)]" />
                <div className="text-sm text-[var(--color-text-primary)]">
                  <div className="font-medium">Workspace stream is disabled</div>
                  <div className="text-[var(--color-text-secondary)]">
                    {streamMessage || 'Enable stream to restore full realtime dashboard updates.'}
                  </div>
                </div>
              </div>
              <button
                onClick={handleEnableStream}
                disabled={streamPending}
                className="shrink-0 rounded-md border border-[var(--color-warning)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {streamPending ? 'Enabling...' : 'Enable Stream'}
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          <ChatFeed
            selectedChannel={selectedChannel}
            selectedChannelMemberCount={selectedChannelMemberCount}
            selectedChannelArchived={selectedChannelArchived}
            dmLabel={selectedDmLabel}
            onOpenThread={(id) => setThreadMessageId(id)}
            mentionNames={mentionNames}
            onOpenAgent={handleSelectAgent}
          />
          {rightPanel}
        </div>
      </div>
    </div>
  );
}
