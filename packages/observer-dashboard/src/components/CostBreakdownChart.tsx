'use client';

import { CircleDollarSign, Coins } from 'lucide-react';
import type { ConsoleCostStats } from '../types/dashboard';

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

interface CostBreakdownChartProps {
  data: ConsoleCostStats | null;
  loading: boolean;
  error: string | null;
}

export function CostBreakdownChart({ data, loading, error }: CostBreakdownChartProps) {
  const maxCost = Math.max(...(data?.agents.map((agent) => agent.total_cost_usd) ?? [0]));

  return (
    <section className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
      <div className="border-b border-[var(--color-border-default)] px-4 py-3">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Cost Breakdown</h3>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Spend and token usage by agent over the current window.
        </p>
      </div>

      {error ? (
        <div className="px-4 py-8 text-sm text-[var(--color-error)]">{error}</div>
      ) : loading && !data ? (
        <div className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">Loading cost data...</div>
      ) : !data || data.agents.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
          No cost metadata has been reported yet.
        </div>
      ) : (
        <div className="space-y-5 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SummaryCard
              icon={<CircleDollarSign className="h-4 w-4 text-[var(--color-accent-green)]" />}
              label="Total cost"
              value={formatUsd(data.totals.total_cost_usd)}
            />
            <SummaryCard
              icon={<Coins className="h-4 w-4 text-[var(--color-accent-cyan)]" />}
              label="Total tokens"
              value={formatTokens(data.totals.total_tokens)}
            />
          </div>

          <div className="space-y-3">
            {data.agents.map((agent) => {
              const width = maxCost > 0 ? Math.max((agent.total_cost_usd / maxCost) * 100, 6) : 6;
              const promptShare = agent.total_tokens > 0
                ? (agent.prompt_tokens / agent.total_tokens) * 100
                : 0;
              const completionShare = agent.total_tokens > 0
                ? (agent.completion_tokens / agent.total_tokens) * 100
                : 0;

              return (
                <div key={agent.agent_id} className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-[var(--color-text-primary)]">{agent.agent_name}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">
                        {agent.message_count} messages • {formatTokens(agent.total_tokens)} tokens
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                      {formatUsd(agent.total_cost_usd)}
                    </div>
                  </div>

                  <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
                    <div
                      className="h-full rounded-full bg-linear-to-r from-[var(--color-accent-cyan)] to-[var(--color-accent-green)]"
                      style={{ width: `${width}%` }}
                    />
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <TokenMeter label="Prompt" value={agent.prompt_tokens} percent={promptShare} />
                    <TokenMeter label="Completion" value={agent.completion_tokens} percent={completionShare} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-3">
      <div className="mb-2 flex items-center gap-2 text-[var(--color-text-secondary)]">
        {icon}
        <span className="text-xs uppercase tracking-[0.14em]">{label}</span>
      </div>
      <div className="text-lg font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}

function TokenMeter({
  label,
  value,
  percent,
}: {
  label: string;
  value: number;
  percent: number;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
        <span>{label}</span>
        <span>{formatTokens(value)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
        <div
          className="h-full rounded-full bg-[var(--color-accent-orange)]"
          style={{ width: `${Math.max(percent, value > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}
