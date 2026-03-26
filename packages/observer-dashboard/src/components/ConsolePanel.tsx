'use client';

import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ActivityLog } from './ActivityLog';
import { AgentMetricsCards } from './AgentMetricsCards';
import { ConsoleFeed } from './ConsoleFeed';
import { CostBreakdownChart } from './CostBreakdownChart';
import { useConsoleFeed } from '../hooks/use-console-feed';
import { useConsoleAgentStats, useConsoleCostStats, useConsoleOverview } from '../hooks/use-console-stats';
import { cn } from '../lib/utils';

type ConsoleTab = 'feed' | 'metrics' | 'costs' | 'activity';

const TAB_OPTIONS: Array<{ id: ConsoleTab; label: string }> = [
  { id: 'feed', label: 'Feed' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'costs', label: 'Costs' },
  { id: 'activity', label: 'Activity' },
];

export function ConsolePanel() {
  const [activeTab, setActiveTab] = useState<ConsoleTab>('activity');
  const feed = useConsoleFeed();
  const overview = useConsoleOverview();
  const agentStats = useConsoleAgentStats();
  const costStats = useConsoleCostStats();

  const combinedStatsError = useMemo(() => overview.error ?? agentStats.error, [agentStats.error, overview.error]);

  let content: React.ReactNode;
  if (activeTab === 'feed') {
    content = <ConsoleFeed messages={feed.messages} loading={feed.loading} error={feed.error} lastUpdatedAt={feed.lastUpdatedAt} />;
  } else if (activeTab === 'metrics') {
    content = <AgentMetricsCards overview={overview.data} agents={agentStats.data ?? []} recentMessages={feed.messages} loading={overview.loading || agentStats.loading} error={combinedStatsError} />;
  } else if (activeTab === 'costs') {
    content = <CostBreakdownChart data={costStats.data} loading={costStats.loading} error={costStats.error} />;
  } else {
    content = <ActivityLog className="w-full border-l-0 border-none bg-transparent" />;
  }

  return (
    <aside className="console-surface flex w-[440px] shrink-0 flex-col overflow-hidden">
      <div className="border-b border-[color-mix(in_srgb,var(--console-accent)_16%,transparent)] px-5 py-4">
        <div className="relative max-w-[220px]">
          <select
            value={activeTab}
            onChange={(event) => setActiveTab(event.target.value as ConsoleTab)}
            aria-label="Observer console view"
            className={cn(
              'h-11 w-full appearance-none rounded-full border px-4 pr-11 text-sm font-medium outline-none transition-colors',
              'border-[color-mix(in_srgb,var(--console-accent)_18%,transparent)] bg-[color-mix(in_srgb,var(--console-elevated)_84%,transparent)] text-[var(--console-fg)]',
              'focus:border-[color-mix(in_srgb,var(--console-accent)_42%,transparent)] focus:bg-[color-mix(in_srgb,var(--console-accent)_10%,var(--console-elevated))]',
            )}
          >
            {TAB_OPTIONS.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.label}
              </option>
            ))}
          </select>
          <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-[var(--console-muted)]">
            <ChevronDown className="h-4 w-4" />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{content}</div>
    </aside>
  );
}
