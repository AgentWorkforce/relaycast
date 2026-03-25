'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEvent, usePresence, useChannels, useWebSocket, useRelay } from '@relaycast/react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ConsolePanel } from './ConsolePanel';
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
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);

  const fetchDMs = useCallback(() => {
    relay.allDmConversations().then((wdcs) => setConversations(wdcs.map(toSummary))).catch(() => {});
  }, [relay]);

  useEffect(() => {
    fetchDMs();
  }, [fetchDMs]);
  useEvent('dm.received', fetchDMs);
  useEvent('group_dm.received', fetchDMs);

  useEffect(() => {
    if (!selectedChannel && channels.length > 0) {
      const firstChannel = (channels.find((ch) => !ch.isArchived) ?? channels[0]).name;
      setSelectedChannel(firstChannel);
      setUnreadChannelCounts((prev) =>
        prev[firstChannel] && prev[firstChannel] > 0 ? { ...prev, [firstChannel]: 0 } : prev,
      );
    }
  }, [selectedChannel, channels]);

  useEffect(() => {
    const knownChannels = new Set(channels.map((ch) => ch.name));
    setUnreadChannelCounts((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [name, count] of Object.entries(prev)) {
        if (knownChannels.has(name)) next[name] = count;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [channels]);

  useEvent('message.created', (evt) => {
    const event = evt as MessageCreatedEvent;
    const channelName = event.channel;
    if (!channelName || selectedChannel === channelName) return;
    setUnreadChannelCounts((prev) => ({ ...prev, [channelName]: (prev[channelName] ?? 0) + 1 }));
  });

  const mentionableAgents = rawAgents.filter((agent) => !agent.name.startsWith('_dashboard_'));
  const mentionNames = mentionableAgents.map((agent) => agent.name);

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
      setStreamMessage(data.enabled ? '' : 'Workspace stream is disabled. Realtime updates will be incomplete.');
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
    } catch (error) {
      setStreamEnabled(false);
      setStreamMessage(error instanceof Error && error.message ? error.message : 'Failed to enable workspace stream. Please try again.');
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
      setUnreadChannelCounts((prev) => (prev[name] && prev[name] > 0 ? { ...prev, [name]: 0 } : prev));
    }
  }

  const selectedAgentData: ApiAgent | null = selectedAgent
    ? mentionableAgents.find((a) => a.name === selectedAgent) ?? null
    : null;
  const selectedChannelMemberCount =
    selectedChannel && !selectedChannel.startsWith('dm:')
      ? channels.find((ch) => ch.name === selectedChannel)?.memberCount ?? 0
      : null;
  const selectedChannelArchived =
    selectedChannel && !selectedChannel.startsWith('dm:')
      ? channels.find((ch) => ch.name === selectedChannel)?.isArchived ?? false
      : false;
  const selectedDmLabel =
    selectedChannel?.startsWith('dm:')
      ? (() => {
          const conversation = conversations.find((dm) => `dm:${dm.id}` === selectedChannel);
          if (!conversation) return undefined;
          return formatDmLabel(conversation.participants, conversation.name);
        })()
      : undefined;

  const rightPanel = selectedAgentData ? (
    <AgentPanel agent={selectedAgentData} onClose={() => setSelectedAgent(null)} />
  ) : threadMessageId ? (
    <ThreadPanel
      messageId={threadMessageId}
      onClose={() => setThreadMessageId(null)}
      mentionNames={mentionNames}
      onOpenAgent={handleSelectAgent}
    />
  ) : (
    <ConsolePanel />
  );

  return (
    <div className="brand-grid min-h-screen">
      <div className="flex min-h-screen gap-3">
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

        <main className="flex min-w-0 flex-1 flex-col py-3 pr-3">
          {streamEnabled === false && (
            <div className="brand-card mb-3 flex items-start justify-between gap-3 px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-[var(--status-warning)]" />
                <div>
                  <div className="text-sm font-medium text-[var(--foreground)]">Workspace stream is disabled</div>
                  <div className="text-sm text-[var(--text-secondary)]">
                    {streamMessage || 'Enable stream to restore full realtime dashboard updates.'}
                  </div>
                </div>
              </div>
              <button
                onClick={handleEnableStream}
                disabled={streamPending}
                className="shrink-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition-colors hover:bg-[var(--surface-muted)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {streamPending ? 'Enabling…' : 'Enable stream'}
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 gap-3">
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
        </main>
      </div>
    </div>
  );
}
