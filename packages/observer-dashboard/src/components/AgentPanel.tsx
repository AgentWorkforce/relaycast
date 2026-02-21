'use client';

import { X, Bot, User, Clock, Cpu, CircleDot } from 'lucide-react';
import { AgentAvatar } from './AgentAvatar';
import type { Agent } from '@relaycast/sdk';

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusLabel(status: string) {
  switch (status) {
    case 'online':
      return { text: 'Online', color: 'text-green-400', dot: 'bg-green-500' };
    case 'idle':
      return { text: 'Idle', color: 'text-yellow-400', dot: 'bg-yellow-500' };
    case 'away':
      return { text: 'Away', color: 'text-yellow-400', dot: 'bg-yellow-500' };
    default:
      return { text: 'Offline', color: 'text-[var(--color-text-dim)]', dot: 'bg-gray-500' };
  }
}

interface AgentPanelProps {
  agent: Agent;
  onClose: () => void;
}

export function AgentPanel({ agent, onClose }: AgentPanelProps) {
  const status = statusLabel(agent.status);
  const cli = (agent.metadata?.cli as string) || (agent.metadata?.spawn as Record<string, unknown>)?.cli as string || 'unknown';
  const currentTask = (agent.metadata?.current_task as string) || '';

  // Collect metadata entries to display (excluding known fields)
  const extraMeta = Object.entries(agent.metadata || {}).filter(
    ([key]) => !['cli', 'current_task'].includes(key)
  );

  return (
    <div className="w-[360px] shrink-0 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] flex items-center justify-between shrink-0">
        <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">Agent Profile</h2>
        <button
          onClick={onClose}
          className="p-1 rounded-md cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Avatar + name */}
        <div className="flex flex-col items-center pt-6 pb-4 px-4">
          <AgentAvatar name={agent.name} size="md" className="h-14 w-14 text-xl mb-3" />
          <h3 className="text-lg font-bold text-[var(--color-text-primary)]">{agent.name}</h3>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`h-2 w-2 rounded-full ${status.dot}`} />
            <span className={`text-xs ${status.color}`}>{status.text}</span>
            <span className="text-xs text-[var(--color-text-dim)] mx-1">&middot;</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              {agent.type === 'human' ? 'Human' : 'Agent'}
            </span>
          </div>
        </div>

        {/* Persona / bio */}
        {agent.persona && (
          <div className="px-4 pb-4">
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap">
              {agent.persona}
            </p>
          </div>
        )}

        <div className="mx-4 border-t border-[var(--color-border-subtle)]" />

        {/* Info rows */}
        <div className="px-4 py-4 space-y-3">
          {currentTask && (
            <InfoRow
              icon={<CircleDot className="h-3.5 w-3.5" />}
              label="Current task"
              value={currentTask}
            />
          )}
          <InfoRow
            icon={<Cpu className="h-3.5 w-3.5" />}
            label="CLI"
            value={cli}
          />
          <InfoRow
            icon={<Clock className="h-3.5 w-3.5" />}
            label="Last seen"
            value={relativeTime(agent.lastSeen)}
          />
          <InfoRow
            icon={agent.type === 'human' ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
            label="Created"
            value={formatDate(agent.createdAt)}
          />
        </div>

        {/* Extra metadata */}
        {extraMeta.length > 0 && (
          <>
            <div className="mx-4 border-t border-[var(--color-border-subtle)]" />
            <div className="px-4 py-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                Metadata
              </h4>
              <div className="space-y-2">
                {extraMeta.map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2">
                    <span className="text-xs text-[var(--color-text-muted)] shrink-0 min-w-[80px]">{key}</span>
                    <span className="text-xs text-[var(--color-text-secondary)] break-all">
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="text-[var(--color-text-muted)] mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-[var(--color-text-muted)]">{label}</p>
        <p className="text-sm text-[var(--color-text-primary)] break-words">{value}</p>
      </div>
    </div>
  );
}
