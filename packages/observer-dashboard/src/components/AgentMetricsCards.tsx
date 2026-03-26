'use client';

import { AlertTriangle, Clock3, MessagesSquare } from 'lucide-react';
import type { ConsoleAgentStat, ConsoleMessageLog, ConsoleOverview } from '../types/dashboard';

function formatLatency(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 'n/a';
  if (latencyMs >= 1000) return `${(latencyMs / 1000).toFixed(1)}s`;
  return `${latencyMs}ms`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function hasErrorSignal(message: ConsoleMessageLog): boolean {
  const metadata = message.metadata;
  const topLevelStatus = metadata.status;
  const nestedError = metadata.error;
  const nestedCost = metadata._error;
  if (topLevelStatus === 'error' || topLevelStatus === 'failed') return true;
  if (nestedError && typeof nestedError === 'object') return true;
  if (nestedCost && typeof nestedCost === 'object') return true;

  const normalized = message.text.trim().toLowerCase();
  return normalized.startsWith('error:') || normalized.startsWith('failed:');
}

function buildErrorRateMap(messages: ConsoleMessageLog[]): Map<string, number> {
  const counters = new Map<string, { total: number; errors: number }>();

  for (const message of messages) {
    const agentId = message.agent_id;
    const next = counters.get(agentId) ?? { total: 0, errors: 0 };
    next.total += 1;
    if (hasErrorSignal(message)) {
      next.errors += 1;
    }
    counters.set(agentId, next);
  }

  return new Map(
    Array.from(counters.entries()).map(([agentId, counter]) => [
      agentId,
      counter.total > 0 ? (counter.errors / counter.total) * 100 : 0,
    ]),
  );
}

interface AgentMetricsCardsProps {
  overview: ConsoleOverview | null;
  agents: ConsoleAgentStat[];
  recentMessages: ConsoleMessageLog[];
  loading: boolean;
  error: string | null;
}

export function AgentMetricsCards({
  overview,
  agents,
  recentMessages,
  loading,
  error,
}: AgentMetricsCardsProps) {
  const errorRateByAgent = buildErrorRateMap(recentMessages);

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Agent Metrics</h3>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Per-agent throughput, latency, and error signals from recent console logs.
            </p>
          </div>
          {overview && (
            <div className="text-right">
              <div className="text-lg font-semibold text-[var(--color-text-primary)]">
                {overview.total_messages}
              </div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-dim)]">
                Messages / {overview.window_days}d
              </div>
            </div>
          )}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-[var(--color-error)] bg-[var(--color-error-light)] px-4 py-3 text-sm text-[var(--color-error)]">
          {error}
        </div>
      ) : loading && agents.length === 0 ? (
        <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-4 py-10 text-sm text-[var(--color-text-muted)]">
          Loading agent metrics...
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
          No agent metrics available yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {agents.map((agent) => {
            const errorRate = errorRateByAgent.get(agent.agent_id) ?? 0;
            return (
              <article
                key={agent.agent_id}
                className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] p-4"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{agent.agent_name}</h4>
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      {agent.channel_count} channel • {agent.dm_count} DM
                    </p>
                  </div>
                  <div className="rounded-full border border-[var(--color-border-subtle)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-[var(--color-text-dim)]">
                    Active
                  </div>
                </div>

                <div className="grid gap-2">
                  <MetricRow
                    icon={<MessagesSquare className="h-3.5 w-3.5 text-[var(--color-accent-cyan)]" />}
                    label="Messages"
                    value={String(agent.message_count)}
                  />
                  <MetricRow
                    icon={<Clock3 className="h-3.5 w-3.5 text-[var(--color-accent-green)]" />}
                    label="Avg latency"
                    value={formatLatency(agent.avg_latency_ms)}
                  />
                  <MetricRow
                    icon={<AlertTriangle className="h-3.5 w-3.5 text-[var(--color-warning)]" />}
                    label="Error rate"
                    value={formatPercent(errorRate)}
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MetricRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-2">
      <div className="flex items-center gap-2 text-[var(--color-text-secondary)]">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="text-sm font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  );
}
