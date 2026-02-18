'use client';

import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { usePresence, useChannels, useEvent, useAgent, useWebSocket } from '@relaycast/react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ActivityLog } from './ActivityLog';
import { ThreadPanel } from './ThreadPanel';
import { AgentPanel } from './AgentPanel';
import { cn } from '../lib/utils';
import { useWorkspaceDMs } from '../hooks/use-workspace-dms';
import type { Agent as ApiAgent, ChannelCreatedEvent } from '@relaycast/types';

export function DashboardLayout() {
  const { agents: rawAgents } = usePresence();
  const { channels } = useChannels();
  const { conversations } = useWorkspaceDMs();
  const agentClient = useAgent();
  const { status: wsStatus } = useWebSocket();

  // Auto-join observer to newly created channels so we receive WS events
  useEvent('channel.created', (evt) => {
    const e = evt as ChannelCreatedEvent;
    agentClient.channels.join(e.channel.name).catch(() => {});
  });
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(true);

  // Default to first channel if none selected
  useEffect(() => {
    if (!selectedChannel && channels.length > 0) {
      setSelectedChannel(channels[0].name);
    }
  }, [selectedChannel, channels]);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);

  // Filter out the dashboard observer agent
  const agents = rawAgents.filter((a) => !a.name.startsWith('_dashboard_'));

  function handleSelectAgent(name: string | null) {
    setSelectedAgent(name);
    if (name) setThreadMessageId(null);
  }

  function handleSelectChannel(name: string | null) {
    setSelectedChannel(name);
    setSelectedAgent(null);
    setThreadMessageId(null);
  }

  // Determine right panel priority: agent panel > thread > activity
  const selectedAgentData: ApiAgent | null = selectedAgent
    ? agents.find((a) => a.name === selectedAgent) ?? null
    : null;

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
      />
    );
  } else if (activityOpen) {
    rightPanel = <ActivityLog />;
  }

  const showActivityToggle = !selectedAgentData && !threadMessageId;

  return (
    <div className="h-screen flex bg-[var(--color-bg-deep)]">
      <AgentSidebar
        channels={channels}
        agents={agents}
        conversations={conversations}
        selectedChannel={selectedChannel}
        selectedAgent={selectedAgent}
        wsStatus={wsStatus}
        onSelectChannel={handleSelectChannel}
        onSelectAgent={handleSelectAgent}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {showActivityToggle && (
          <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
            <button
              onClick={() => setActivityOpen(!activityOpen)}
              className={cn(
                'p-1.5 rounded-md cursor-pointer transition-colors',
                activityOpen
                  ? 'text-[var(--color-accent-cyan)] bg-[var(--color-bg-active)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]'
              )}
              title="Toggle activity panel"
            >
              <Activity className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="flex flex-1 min-h-0">
          <ChatFeed
            selectedChannel={selectedChannel}
            dmLabel={
              selectedChannel?.startsWith('dm:')
                ? conversations.find((dm) => `dm:${dm.id}` === selectedChannel)?.name ?? undefined
                : undefined
            }
            onOpenThread={(id) => setThreadMessageId(id)}
          />
          {rightPanel}
        </div>
      </div>
    </div>
  );
}
