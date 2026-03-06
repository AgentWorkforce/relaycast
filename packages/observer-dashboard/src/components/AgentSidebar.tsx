'use client';

import { useEffect, useState } from 'react';
import { Hash, MessageSquare, LogOut, Sun, Moon } from 'lucide-react';
import { cn, formatDmLabel } from '../lib/utils';
import { withBasePath } from '../lib/basePath';
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
    <div className="w-[260px] shrink-0 flex flex-col border-r border-[var(--color-border-default)] bg-[var(--color-sidebar-bg)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] flex items-center gap-2">
        <img
          src={theme === 'dark' ? withBasePath('/brand/agent-relay-logo-white.svg') : withBasePath('/brand/agent-relay-logo-black.svg')}
          alt="Agent Relay"
          className="h-5 w-auto shrink-0"
        />
        <h1 className="text-sm font-black tracking-wide uppercase [font-family:Outfit,sans-serif] truncate">
          <span className="bg-gradient-to-r from-[var(--color-success)] to-[var(--color-accent-cyan)] bg-clip-text text-transparent">
            Observer
          </span>
        </h1>
        <span
          className={cn('h-2 w-2 rounded-full shrink-0', {
            'bg-green-500': wsStatus === 'connected',
            'bg-yellow-500 animate-pulse': wsStatus === 'connecting' || wsStatus === 'reconnecting',
            'bg-red-500': wsStatus === 'disconnected',
          })}
          title={`WebSocket: ${wsStatus}`}
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto">
        {/* Channels */}
        <div className="px-3 pt-4 pb-2">
          <h2 className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
            Channels
          </h2>
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => {
                onSelectAgent(null);
                onSelectChannel(selectedChannel === ch.name ? null : ch.name);
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                selectedChannel === ch.name
                  ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]',
                ch.isArchived && 'opacity-70'
              )}
            >
              <Hash className="h-3.5 w-3.5 shrink-0 opacity-60" />
              <span className="truncate flex-1 text-left">{ch.name}</span>
              {(unreadChannelCounts[ch.name] ?? 0) > 0 && (
                <span className="text-[10px] font-semibold text-white bg-red-500 px-1.5 py-0.5 rounded-full shrink-0">
                  {unreadChannelCounts[ch.name]}
                </span>
              )}
            </button>
          ))}
          {channels.length === 0 && (
            <p className="px-2 text-xs text-[var(--color-text-dim)]">No channels</p>
          )}
        </div>

        {/* Direct Messages */}
        {conversations.length > 0 && (
          <>
            <div className="mx-3 border-t border-[var(--color-border-subtle)]" />
            <div className="px-3 pt-3 pb-2">
              <h2 className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                Direct Messages
              </h2>
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
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                      selectedChannel === dmKey
                        ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]'
                    )}
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    <span className="truncate flex-1 text-left">{dmLabel}</span>
                    {dm.unreadCount > 0 && (
                      <span className="text-[10px] text-[var(--color-text-dim)] bg-[var(--color-bg-hover)] px-1.5 py-0.5 rounded-full shrink-0">
                        {dm.unreadCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        <div className="mx-3 border-t border-[var(--color-border-subtle)]" />

        {/* Agents */}
        <div className="px-3 pt-3 pb-2">
          <h2 className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
            Agents
          </h2>
          {agents.map((agent) => (
            <button
              key={agent.name}
              onClick={() => {
                onSelectAgent(selectedAgent === agent.name ? null : agent.name);
              }}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer transition-colors',
                selectedAgent === agent.name
                  ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-sidebar-hover)]'
              )}
            >
              <AgentAvatar name={agent.name} size="sm" />
              <span className="truncate flex-1 text-left">{agent.name}</span>
              <span className={cn('h-2 w-2 rounded-full shrink-0', statusColor(agent.status))} />
              <span className="text-[10px] text-[var(--color-text-dim)] shrink-0">
                {(agent.metadata?.cli as string) || (agent.metadata?.spawn as Record<string, unknown>)?.cli as string || agent.type}
              </span>
            </button>
          ))}
          {agents.length === 0 && (
            <p className="px-2 text-xs text-[var(--color-text-dim)]">No agents</p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-[var(--color-border-default)] flex flex-col gap-1">
        <button
          onClick={toggleTheme}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-sidebar-hover)] transition-colors"
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {theme === 'dark' ? 'Light mode' : 'Dark mode'}
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-sidebar-hover)] transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </div>
  );
}
