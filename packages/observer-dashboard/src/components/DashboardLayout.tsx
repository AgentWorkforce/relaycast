'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useEvent, usePresence, useChannels, useWebSocket, useRelay } from '@relaycast/react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ActivityLog } from './ActivityLog';
import { ThreadPanel } from './ThreadPanel';
import { AgentPanel } from './AgentPanel';
import { formatDmLabel, cn } from '../lib/utils';
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

function useIsMobile(breakpoint = 1024) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = (event?: MediaQueryListEvent) => setIsMobile(event ? event.matches : mediaQuery.matches);

    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, [breakpoint]);

  return isMobile;
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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const isMobile = useIsMobile();

  const fetchDMs = useCallback(() => {
    relay.allDmConversations()
      .then((wdcs) => setConversations(wdcs.map(toSummary)))
      .catch(() => {});
  }, [relay]);

  useEffect(() => { fetchDMs(); }, [fetchDMs]);
  useEvent('dm.received', fetchDMs);
  useEvent('group_dm.received', fetchDMs);

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

  useEffect(() => {
    if (!isMobile) {
      setMobileSidebarOpen(false);
      setMobileInspectorOpen(false);
    }
  }, [isMobile]);

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
    if (name) {
      setThreadMessageId(null);
      if (isMobile) setMobileInspectorOpen(true);
    }
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
    if (isMobile) {
      setMobileSidebarOpen(false);
      setMobileInspectorOpen(false);
    }
  }

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
  let inspectorTitle = 'Activity';
  if (selectedAgentData) {
    inspectorTitle = selectedAgentData.name;
    rightPanel = (
      <AgentPanel
        agent={selectedAgentData}
        onClose={() => {
          setSelectedAgent(null);
          if (isMobile) setMobileInspectorOpen(false);
        }}
      />
    );
  } else if (threadMessageId) {
    inspectorTitle = 'Thread';
    rightPanel = (
      <ThreadPanel
        messageId={threadMessageId}
        onClose={() => {
          setThreadMessageId(null);
          if (isMobile) setMobileInspectorOpen(false);
        }}
        mentionNames={mentionNames}
        onOpenAgent={handleSelectAgent}
      />
    );
  } else {
    rightPanel = <ActivityLog />;
  }

  function handleOpenThread(id: string) {
    setThreadMessageId(id);
    setSelectedAgent(null);
    if (isMobile) setMobileInspectorOpen(true);
  }

  return (
    <div className="flex min-h-[100dvh] bg-[var(--color-bg-deep)] text-[var(--color-text-primary)]">
      <div className="hidden lg:flex lg:shrink-0">
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
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {streamEnabled === false && (
          <div className="mx-3 mt-3 rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-light)] p-3 sm:mx-4 sm:mt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
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
                className="min-h-11 shrink-0 rounded-lg border border-[var(--color-warning)] bg-[var(--color-bg-secondary)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {streamPending ? 'Enabling...' : 'Enable Stream'}
              </button>
            </div>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <ChatFeed
            selectedChannel={selectedChannel}
            selectedChannelMemberCount={selectedChannelMemberCount}
            selectedChannelArchived={selectedChannelArchived}
            dmLabel={selectedDmLabel}
            onOpenThread={handleOpenThread}
            mentionNames={mentionNames}
            onOpenAgent={handleSelectAgent}
            isMobile={isMobile}
            onToggleSidebar={() => setMobileSidebarOpen(true)}
            onToggleInspector={() => setMobileInspectorOpen(true)}
            inspectorTitle={inspectorTitle}
          />
          <div className="hidden lg:flex lg:shrink-0">{rightPanel}</div>
        </div>
      </div>

      <MobileOverlay
        open={isMobile && mobileSidebarOpen}
        title="Browse"
        onClose={() => setMobileSidebarOpen(false)}
      >
        <AgentSidebar
          channels={channels}
          agents={agents}
          conversations={conversations}
          selectedChannel={selectedChannel}
          selectedAgent={selectedAgent}
          unreadChannelCounts={unreadChannelCounts}
          wsStatus={wsStatus}
          onSelectChannel={handleSelectChannel}
          onSelectAgent={(name) => {
            handleSelectAgent(name);
            setMobileSidebarOpen(false);
          }}
          className="h-full w-full max-w-none border-r-0"
        />
      </MobileOverlay>

      <MobileOverlay
        open={isMobile && mobileInspectorOpen}
        title={inspectorTitle}
        side="right"
        onClose={() => setMobileInspectorOpen(false)}
      >
        <div className="h-full">{rightPanel}</div>
      </MobileOverlay>
    </div>
  );
}

function MobileOverlay({
  open,
  title,
  side = 'left',
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  side?: 'left' | 'right';
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 transition-opacity duration-200 lg:hidden',
        open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
      />
      <div
        className={cn(
          'absolute inset-y-0 flex w-full max-w-[92vw] flex-col bg-[var(--color-bg-primary)] shadow-2xl transition-transform duration-200',
          side === 'left' ? 'left-0' : 'right-0',
          open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full',
        )}
      >
        <div className="flex min-h-14 items-center justify-between border-b border-[var(--color-border-default)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
