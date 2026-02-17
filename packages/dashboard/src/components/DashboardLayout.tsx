'use client';

import { useState } from 'react';
import { Activity } from 'lucide-react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ActivityLog } from './ActivityLog';
import { ThreadPanel } from './ThreadPanel';
import { AgentPanel } from './AgentPanel';
import { useDashboardData, useChannels } from '../hooks/use-dashboard-data';
import { synthesizeActivityEvents } from '../lib/activity';
import { cn } from '../lib/utils';

export function DashboardLayout() {
  const { agents, messages } = useDashboardData();
  const { channels } = useChannels();
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(true);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);

  const activityEvents = synthesizeActivityEvents(agents, messages);

  function handleSelectAgent(name: string | null) {
    setSelectedAgent(name);
    // Close thread when switching agents
    if (name) setThreadMessageId(null);
  }

  function handleSelectChannel(name: string | null) {
    setSelectedChannel(name);
    setSelectedAgent(null);
    setThreadMessageId(null);
  }

  // Determine right panel priority: agent panel > thread > activity
  const selectedAgentData = selectedAgent
    ? agents.find((a) => a.name === selectedAgent) ?? null
    : null;

  const agentMessageCount = selectedAgent
    ? messages.filter((m) => m.from === selectedAgent).length
    : 0;

  let rightPanel: React.ReactNode = null;
  if (selectedAgentData) {
    rightPanel = (
      <AgentPanel
        agent={selectedAgentData}
        messageCount={agentMessageCount}
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
    rightPanel = <ActivityLog events={activityEvents} />;
  }

  const showActivityToggle = !selectedAgentData && !threadMessageId;

  return (
    <div className="h-screen flex bg-[var(--color-bg-deep)]">
      <AgentSidebar
        channels={channels}
        agents={agents}
        selectedChannel={selectedChannel}
        selectedAgent={selectedAgent}
        onSelectChannel={handleSelectChannel}
        onSelectAgent={handleSelectAgent}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Toggle bar */}
        {showActivityToggle && (
          <div className="absolute top-3 right-4 z-10">
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
            messages={messages}
            selectedChannel={selectedChannel}
            selectedAgent={null}
            onOpenThread={(id) => setThreadMessageId(id)}
          />
          {rightPanel}
        </div>
      </div>
    </div>
  );
}
