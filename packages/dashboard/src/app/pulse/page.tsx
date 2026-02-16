'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthGate } from '../../components/AuthGate';
import { clearAuth } from '../../lib/auth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface PulseMessage {
  id: string;
  ts: number;
  from: string;
  to: string;
  kind: string;
  body: string;
}

interface RecentMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  color: string;
  timestamp: number;
}

/** Sample messages for demo when no live data is available */
function generateSampleMessages(): PulseMessage[] {
  const agents = ['Lead', 'Architect', 'Frontend', 'Backend', 'DevOps'];
  const bodies = [
    'Starting implementation of the auth module',
    'PR ready for review — added input validation',
    'Deploying staging build now',
    'Database migration complete, schema updated',
    'Tests passing on CI, merging to main',
    'Found a race condition in the queue handler',
    'Refactored the API layer to use connection pooling',
    'Reviewing the security audit findings',
    'Cache invalidation strategy looks good',
    'Scaling worker pool to handle peak traffic',
    'Monitoring shows latency spike — investigating',
    'Rolled back the config change, traffic restored',
    'New feature flag enabled for beta users',
    'Documentation updated for the v2 endpoints',
    'Load test results: 3x throughput improvement',
  ];
  const now = Date.now();
  const msgs: PulseMessage[] = [];
  for (let i = 0; i < 60; i++) {
    const from = agents[i % agents.length];
    let to = agents[(i + 1 + Math.floor(i / agents.length)) % agents.length];
    if (i % 5 === 0) to = '#general';
    msgs.push({
      id: `sample-${i}`,
      ts: now - (60 - i) * 2000,
      from,
      to,
      kind: 'message',
      body: bodies[i % bodies.length],
    });
  }
  return msgs;
}

function truncateBody(body: string, maxLen: number = 100): string {
  if (body.length <= maxLen) return body;
  return body.substring(0, maxLen) + '...';
}

const MAX_RECENT = 10;

export default function PulsePage() {
  const router = useRouter();
  const elRef = useRef<HTMLElement>(null);
  const [messages, setMessages] = useState<PulseMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [elementReady, setElementReady] = useState(false);
  const [recentMessages, setRecentMessages] = useState<RecentMessage[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  // Register the custom element on mount
  useEffect(() => {
    import('@agent-relay/pulse/element').then(() => {
      setElementReady(true);
    });
  }, []);

  // Fetch messages from the dashboard data API
  useEffect(() => {
    fetch('/api/data')
      .then((res) => res.json())
      .then((data) => {
        const raw = data.messages || [];
        const pulseMessages: PulseMessage[] = raw.map(
          (m: { id: string; from: string; to: string; content: string; timestamp: string }) => ({
            id: m.id,
            ts: new Date(m.timestamp).getTime(),
            from: m.from,
            to: m.to,
            kind: 'message',
            body: m.content,
          })
        );
        const useSample = pulseMessages.length === 0 && process.env.NODE_ENV === 'development';
        setMessages(useSample ? generateSampleMessages() : pulseMessages);
        setLoading(false);
      })
      .catch(() => {
        if (process.env.NODE_ENV === 'development') {
          setMessages(generateSampleMessages());
        }
        setLoading(false);
      });
  }, []);

  // Pass messages to the custom element as a JS property
  useEffect(() => {
    if (elRef.current && messages.length > 0) {
      (elRef.current as unknown as { messages: PulseMessage[] }).messages = messages;
    }
  }, [messages, elementReady]);

  // Listen for message events dispatched by the custom element
  const handleMessageEvent = useCallback((e: Event) => {
    const detail = (e as CustomEvent<RecentMessage>).detail;
    if (detail) {
      setRecentMessages((prev) => [detail, ...prev].slice(0, MAX_RECENT));
    }
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.addEventListener('message', handleMessageEvent);
    return () => el.removeEventListener('message', handleMessageEvent);
  }, [elementReady, handleMessageEvent]);

  // Sync pause state to the custom element
  useEffect(() => {
    if (elRef.current) {
      (elRef.current as unknown as { isPaused: boolean }).isPaused = isPaused;
    }
  }, [isPaused]);

  async function handleLogout() {
    await clearAuth();
    router.push('/login');
  }

  return (
    <AuthGate>
      <div className="min-h-screen flex flex-col bg-[#0f172a]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors bg-black/50 backdrop-blur"
            >
              Back to Dashboard
            </Link>
            <h1 className="text-sm font-medium text-gray-300">Pulse Visualization</h1>
            {messages.length > 0 && (
              <span className="text-xs text-gray-500">{messages.length} messages</span>
            )}
          </div>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors bg-black/50 backdrop-blur"
          >
            Sign out
          </button>
        </div>

        {/* Main content */}
        <div className="flex-1 flex">
          {loading ? (
            <div className="flex items-center justify-center flex-1 min-h-[400px]">
              <p className="text-gray-500 text-sm">Loading messages...</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center flex-1 min-h-[400px]">
              <p className="text-gray-500 text-sm">No messages to visualize yet.</p>
            </div>
          ) : (
            <>
              {/* Canvas */}
              <div className="flex-1 relative">
                {elementReady && (
                  <animated-flow
                    ref={elRef}
                    style={{ width: '100%', height: '100%', display: 'block', minHeight: '500px' }}
                  />
                )}
              </div>

              {/* Message Feed Sidebar */}
              <div
                className={`w-96 border-l border-gray-800 flex flex-col ${isPaused ? 'ring-2 ring-cyan-500 ring-inset' : ''}`}
                onMouseEnter={() => setIsPaused(true)}
                onMouseLeave={() => setIsPaused(false)}
              >
                <div className="px-4 py-3 border-b border-gray-800 bg-[#0f172a]/80 flex items-center justify-between shrink-0">
                  <h4 className="text-sm font-medium text-gray-300">Live Feed</h4>
                  {isPaused && (
                    <span className="text-xs text-cyan-400 flex items-center gap-1">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                      </svg>
                      Paused
                    </span>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {recentMessages.map((msg) => (
                    <button
                      key={msg.id}
                      className="w-full text-left px-4 py-3 border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors cursor-pointer"
                      onClick={() => setExpandedId(expandedId === msg.id ? null : msg.id)}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium text-white"
                          style={{ backgroundColor: msg.color }}
                        >
                          {msg.from}
                        </span>
                        <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                        <span className="text-xs text-gray-400">{msg.to}</span>
                        <svg
                          className={`w-3 h-3 text-gray-500 ml-auto transition-transform ${expandedId === msg.id ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                      {expandedId === msg.id ? (
                        <p className="text-sm text-gray-300 whitespace-pre-wrap break-words mt-2">{msg.body}</p>
                      ) : (
                        <p className="text-xs text-gray-400 line-clamp-2">{truncateBody(msg.body)}</p>
                      )}
                    </button>
                  ))}
                  {recentMessages.length === 0 && (
                    <div className="px-4 py-8 text-sm text-gray-500 text-center">
                      Waiting for messages...
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AuthGate>
  );
}
