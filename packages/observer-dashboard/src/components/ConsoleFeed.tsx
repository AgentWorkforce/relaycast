'use client';

import { ActivitySquare, CircleDollarSign, MessageSquareText, TimerReset } from 'lucide-react';
import type { ConsoleMessageLog } from '../types/dashboard';

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatLatency(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 'n/a';
  if (latencyMs >= 1000) return `${(latencyMs / 1000).toFixed(1)}s`;
  return `${latencyMs}ms`;
}

function getCostUsd(metadata: Record<string, unknown>): number | null {
  const cost = metadata._cost;
  if (!cost || typeof cost !== 'object') return null;
  const totalUsd = (cost as Record<string, unknown>).total_usd;
  return typeof totalUsd === 'number' ? totalUsd : null;
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null || costUsd <= 0) return 'n/a';
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}

function targetLabel(message: ConsoleMessageLog): string {
  if (message.delivery_kind === 'dm') return message.conversation_id ? `DM ${message.conversation_id.slice(-6)}` : 'Direct message';
  return message.channel_name ? `#${message.channel_name}` : 'Channel';
}

interface ConsoleFeedProps {
  messages: ConsoleMessageLog[];
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
}

export function ConsoleFeed({ messages, loading, error, lastUpdatedAt }: ConsoleFeedProps) {
  return (
    <section className="console-subtle overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--console-accent)_14%,transparent)] px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--console-fg)]">Live message feed</h3>
          <p className="text-[11px] text-[var(--console-muted)]">Recent console logs with latency and spend signals.</p>
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--console-muted)]">{lastUpdatedAt ? `Updated ${formatTime(lastUpdatedAt)}` : 'Waiting for data'}</div>
      </div>

      {error ? (
        <div className="px-4 py-8 text-sm text-rose-300">{error}</div>
      ) : loading && messages.length === 0 ? (
        <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-[var(--console-muted)]">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--console-accent)] border-t-transparent" />
          Loading console feed…
        </div>
      ) : messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-sm text-[var(--console-muted)]">
          <MessageSquareText className="h-6 w-6 opacity-60" />
          No console messages yet.
        </div>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="sticky top-0 bg-[var(--console-elevated)] text-[10px] uppercase tracking-[0.16em] text-[var(--console-muted)]">
              <tr>
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-3 py-3 font-medium">Agent</th>
                <th className="px-3 py-3 font-medium">Target</th>
                <th className="px-3 py-3 font-medium">Latency</th>
                <th className="px-3 py-3 font-medium">Cost</th>
                <th className="px-3 py-3 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => {
                const costUsd = getCostUsd(message.metadata);
                return (
                  <tr key={message.id} className="border-t border-[color-mix(in_srgb,var(--console-accent)_10%,transparent)] align-top hover:bg-white/2">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-[var(--console-muted)]">{formatTime(message.created_at)}</td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-[var(--console-fg)]">{message.agent_name ?? 'Unknown'}</div>
                      <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--console-accent)_14%,transparent)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--console-muted)]">
                        <ActivitySquare className="h-3 w-3" />
                        {message.delivery_kind}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[var(--console-fg)]/80">{targetLabel(message)}</td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1 text-[var(--console-fg)]/85"><TimerReset className="h-3.5 w-3.5 text-[var(--console-accent)]" />{formatLatency(message.latency_ms)}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1 text-[var(--console-fg)]/85"><CircleDollarSign className="h-3.5 w-3.5 text-[var(--console-green)]" />{formatCost(costUsd)}</span>
                    </td>
                    <td className="max-w-[280px] px-3 py-3 text-[var(--console-fg)]/80"><div className="line-clamp-2 break-words">{message.text || 'No text body'}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
