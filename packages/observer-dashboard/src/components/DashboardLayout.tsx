'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle } from 'lucide-react';
import { usePresence, useChannels, useWebSocket } from '@relaycast/react';
import { AgentSidebar } from './AgentSidebar';
import { ChatFeed } from './ChatFeed';
import { ActivityLog } from './ActivityLog';
import { ThreadPanel } from './ThreadPanel';
import { AgentPanel } from './AgentPanel';
import { cn } from '../lib/utils';
import { useWorkspaceDMs } from '../hooks/use-workspace-dms';
import type { Agent as ApiAgent } from '@relaycast/sdk';

export function DashboardLayout() {
  const { agents: rawAgents } = usePresence();
  const { channels } = useChannels();
  const { conversations } = useWorkspaceDMs();
  const { status: wsStatus } = useWebSocket();
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(true);
  const [streamEnabled, setStreamEnabled] = useState<boolean | null>(null);
  const [streamMessage, setStreamMessage] = useState<string>('');
  const [streamPending, setStreamPending] = useState(false);

  // Default to first channel if none selected
  useEffect(() => {
    if (!selectedChannel && channels.length > 0) {
      setSelectedChannel(channels[0].name);
    }
  }, [selectedChannel, channels]);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);

  // Filter out the dashboard observer agent
  const agents = rawAgents.filter((a) => !a.name.startsWith('_dashboard_'));

  const refreshStreamStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/workspace/stream', { cache: 'no-store' });
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
      const res = await fetch('/api/workspace/stream', {
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
