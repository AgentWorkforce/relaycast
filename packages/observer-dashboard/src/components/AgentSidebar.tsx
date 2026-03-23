'use client';

import { useEffect, useState } from 'react';
import { Hash, MessageSquare, LogOut, Sun, Moon } from 'lucide-react';
import { cn, formatDmLabel } from '../lib/utils';

import { AgentAvatar } from './AgentAvatar';
import { clearAuth } from '../lib/auth';
import { useRouter } from 'next/navigation';
import type { Agent, Channel, DmConversationSummary } from '@relaycast/sdk';

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface AgentSidebarProps {
  channels: Channel[];
  agents: Agent[];
  conversations: DmConversationSummary[];
  selectedChannel: string | null;
  selectedAgent: string | null;
  unreadChannelCounts: Record<string, number>;
  wsStatus: ConnectionStatus;
  onSelectChannel: (name: string | null) => void;
  onSelectAgent: (name: string | null) => void;
  className?: string;
}

function statusColor(status: string) {
  switch (status) {
    case 'online':
      return 'bg-green-500';
    case 'idle':
      return 'bg-yellow-500';
    default:
      return 'bg-gray-500';
  }
}

function getTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
}

export function AgentSidebar({
  channels,
  agents,
  conversations,
  selectedChannel,
  selectedAgent,
  unreadChannelCounts,
  wsStatus,
  onSelectChannel,
  onSelectAgent,
  className,
}: AgentSidebarProps) {
  const router = useRouter();
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    const el = document.documentElement;
    el.classList.add('theme-transitioning');
    el.classList.remove('theme-dark', 'theme-light', 'dark', 'light');
    el.classList.add(next === 'dark' ? 'theme-dark' : 'theme-light', next);
    setTheme(next);
    setTimeout(() => el.classList.remove('theme-transitioning'), 300);
  }

  async function handleLogout() {
    await clearAuth();
    router.push('/login');
  }

  return (
    <div className={cn('flex h-full w-[280px] shrink-0 flex-col border-r border-[var(--color-border-default)] bg-[var(--color-sidebar-bg)]', className)}>
      <div className="flex min-h-14 items-center gap-2 border-b border-[var(--color-border-default)] px-4 py-3">
        <img
          src={theme === 'dark' ? '/observer/brand/agent-relay-logo-white.svg' : '/observer/brand/agent-relay-logo-black.svg'}
          alt="Agent Relay"
          className="h-5 w-auto shrink-0"
        />
        <h1 className="truncate text-sm font-semibold tracking-[0.12em] uppercase text-[var(--color-text-secondary)] [font-family:Outfit,sans-serif]">
          Observer
        </h1>
        <span
          className={cn('ml-auto h-2.5 w-2.5 rounded-full shrink-0', {
            'bg-green-500': wsStatus === 'connected',
            'bg-yellow-500 animate-pulse': wsStatus === 'connecting' || wsStatus === 'reconnecting',
            'bg-red-500': wsStatus === 'disconnected',
          })}
          title={`WebSocket: ${wsStatus}`}
        />
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        <SidebarSection title="Channels">
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => {
                onSelectAgent(null);
                onSelectChannel(selectedChannel === ch.name ? null : ch.name);
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                selectedChannel === ch.name
                  ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]',
                ch.isArchived && 'opacity-70'
              )}
            >
              <Hash className="h-4 w-4 shrink-0 opacity-60" />
              <span className="min-w-0 flex-1 truncate text-left">{ch.name}</span>
              {(unreadChannelCounts[ch.name] ?? 0) > 0 && (
                <span className="shrink-0 rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-semibold leading-4 text-white">
                  {unreadChannelCounts[ch.name]}
                </span>
              )}
            </button>
          ))}
          {channels.length === 0 && (
            <p className="px-3 text-xs text-[var(--color-text-dim)]">No channels</p>
          )}
        </SidebarSection>

        {conversations.length > 0 && (
          <>
            <div className="mx-4 border-t border-[var(--color-border-subtle)]" />
            <SidebarSection title="Direct Messages">
              {conversations.map((dm) => {
                const dmKey = `dm:${dm.id}`;
                const dmLabel = formatDmLabel(dm.participants, dm.name);
                return (
                  <button
                    key={dm.id}
                    onClick={() => {
                      onSelectAgent(null);
                      onSelectChannel(selectedChannel === dmKey ? null : dmKey);
                    }}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                      selectedChannel === dmKey
                        ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]'
                    )}
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate text-left">{dmLabel}</span>
                    {dm.unreadCount > 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--color-bg-hover)] px-2 py-0.5 text-[10px] text-[var(--color-text-dim)]">
                        {dm.unreadCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </SidebarSection>
          </>
        )}

        <div className="mx-4 border-t border-[var(--color-border-subtle)]" />

        <SidebarSection title="Agents">
          {agents.map((agent) => (
            <button
              key={agent.name}
              onClick={() => {
                onSelectAgent(selectedAgent === agent.name ? null : agent.name);
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                selectedAgent === agent.name
                  ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]'
              )}
            >
              <AgentAvatar name={agent.name} size="sm" className="h-7 w-7 text-xs" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', statusColor(agent.status))} />
              <span className="hidden max-w-[7rem] truncate text-[10px] text-[var(--color-text-dim)] sm:block">
                {(agent.metadata?.cli as string) || (agent.metadata?.spawn as Record<string, unknown>)?.cli as string || agent.type}
              </span>
            </button>
          ))}
          {agents.length === 0 && (
            <p className="px-3 text-xs text-[var(--color-text-dim)]">No agents</p>
          )}
        </SidebarSection>
      </div>

      <div className="border-t border-[var(--color-border-default)] px-3 py-3">
        <div className="flex flex-col gap-1.5">
          <button
            onClick={toggleTheme}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-text-primary)]"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button
            onClick={handleLogout}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-sidebar-hover)] hover:text-[var(--color-text-primary)]"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-3">
      <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
        {title}
      </h2>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
