'use client';

import { useMemo, useState } from 'react';
import { BarChart3, Gauge, Radio, Wifi } from 'lucide-react';
import { ActivityLog } from './ActivityLog';
import { AgentMetricsCards } from './AgentMetricsCards';
import { ConsoleFeed } from './ConsoleFeed';
import { CostBreakdownChart } from './CostBreakdownChart';
import { useConsoleFeed } from '../hooks/use-console-feed';
import { useConsoleAgentStats, useConsoleCostStats, useConsoleOverview } from '../hooks/use-console-stats';
import { cn } from '../lib/utils';

type ConsoleTab = 'feed' | 'metrics' | 'costs' | 'activity';

const TAB_OPTIONS: Array<{ id: ConsoleTab; label: string; icon: React.ReactNode }> = [
  { id: 'feed', label: 'Feed', icon: <Radio className="h-3.5 w-3.5" /> },
  { id: 'metrics', label: 'Metrics', icon: <Gauge className="h-3.5 w-3.5" /> },
  { id: 'costs', label: 'Costs', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: 'activity', label: 'Activity', icon: <Wifi className="h-3.5 w-3.5" /> },
];

export function ConsolePanel() {
  const [activeTab, setActiveTab] = useState<ConsoleTab>('feed');
  const feed = useConsoleFeed();
  const overview = useConsoleOverview();
  const agentStats = useConsoleAgentStats();
  const costStats = useConsoleCostStats();

  const combinedStatsError = useMemo(
    () => overview.error ?? agentStats.error,
    [agentStats.error, overview.error],
  );

  let content: React.ReactNode;
  if (activeTab === 'feed') {
    content = (
      <ConsoleFeed
        messages={feed.messages}
        loading={feed.loading}
        error={feed.error}
        lastUpdatedAt={feed.lastUpdatedAt}
      />
    );
  } else if (activeTab === 'metrics') {
    content = (
      <AgentMetricsCards
        overview={overview.data}
        agents={agentStats.data ?? []}
        recentMessages={feed.messages}
        loading={overview.loading || agentStats.loading}
        error={combinedStatsError}
      />
    );
  } else if (activeTab === 'costs') {
    content = (
      <CostBreakdownChart
        data={costStats.data}
        loading={costStats.loading}
        error={costStats.error}
      />
    );
  } else {
    content = <ActivityLog className="w-full border-l-0" />;
  }

  return (
    <aside className="w-[420px] shrink-0 border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
      <div className="border-b border-[var(--color-border-default)] px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Observer Console</h2>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Realtime operations views for feed, metrics, and cost.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {TAB_OPTIONS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-[var(--color-accent-cyan)] bg-[var(--color-accent-light)] text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[calc(100vh-73px)] overflow-y-auto p-4">
        {content}
      </div>
    </aside>
  );
}
