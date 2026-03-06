'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useEvent, usePresence, useChannels, useWebSocket, useDMs } from '@relaycast/react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ActivityLog } from './ActivityLog';
import { ThreadPanel } from './ThreadPanel';
import { AgentPanel } from './AgentPanel';
import { formatDmLabel } from '../lib/utils';
import type { Agent as ApiAgent, MessageCreatedEvent } from '@relaycast/sdk';

export function DashboardLayout() {
  const { agents: rawAgents } = usePresence();
  const { channels } = useChannels({ includeArchived: true });
  const { conversations } = useDMs();
  const { status: wsStatus } = useWebSocket();
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [unreadChannelCounts, setUnreadChannelCounts] = useState<Record<string, number>>({});
  const [streamEnabled, setStreamEnabled] = useState<boolean | null>(null);
  const [streamMessage, setStreamMessage] = useState<string>('');
  const [streamPending, setStreamPending] = useState(false);

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
      const res = await fetch('/observer/api/workspace/stream', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success !== true || typeof data.enabled !== 'boolean') {
        throw new Error('Unable to verify workspace stream status');
      }
      setStreamEnabled(data.enabled);
      if (data.enabled) {
        setStreamMessage('');
      } else {
        setStreamMessage('Workspace stream is disabled. Realtime updates will be incomplete.');
      }
    } catch {
      setStreamEnabled(null);
      setStreamMessage('');
    }
  }, []);

  useEffect(() => {
    void refreshStreamStatus();
  }, [refreshStreamStatus]);

  async function handleEnableStream() {
    setStreamPending(true);
    setStreamMessage('');
    try {
      const res = await fetch('/observer/api/workspace/stream', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.success !== true || data.enabled !== true) {
        const detail = typeof data?.detail === 'string' && data.detail.length > 0
          ? data.detail
          : 'Failed to enable workspace stream';
        const baseUrl = typeof data?.baseUrl === 'string' && data.baseUrl.length > 0
          ? ` (base: ${data.baseUrl})`
          : '';
        throw new Error(`${detail}${baseUrl}`);
      }
      setStreamEnabled(true);
      setStreamMessage('');
    } catch (error) {
      setStreamEnabled(false);
      const detail = error instanceof Error && error.message
        ? error.message
        : 'Failed to enable workspace stream. Please try again.';
      setStreamMessage(detail);
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
