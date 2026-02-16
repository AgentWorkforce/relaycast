'use client';

import { useEffect, useRef, useState } from 'react';
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

export default function PulsePage() {
  const router = useRouter();
  const elRef = useRef<HTMLElement>(null);
  const [messages, setMessages] = useState<PulseMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [elementReady, setElementReady] = useState(false);

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
        // Transform dashboard messages to pulse format
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
        setMessages(pulseMessages);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Pass messages to the custom element as a JS property
  useEffect(() => {
    if (elRef.current && messages.length > 0) {
      (elRef.current as unknown as { messages: PulseMessage[] }).messages = messages;
    }
  }, [messages, elementReady]);

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
          </div>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors bg-black/50 backdrop-blur"
          >
            Sign out
          </button>
        </div>

        {/* Visualization */}
        <div className="flex-1 relative">
          {loading ? (
            <div className="flex items-center justify-center h-full min-h-[400px]">
              <p className="text-gray-500 text-sm">Loading messages...</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex items-center justify-center h-full min-h-[400px]">
              <p className="text-gray-500 text-sm">No messages to visualize yet.</p>
            </div>
          ) : elementReady ? (
            <animated-flow
              ref={elRef}
              style={{ width: '100%', height: '100%', display: 'block', minHeight: '500px' }}
            />
          ) : null}
        </div>
      </div>
    </AuthGate>
  );
}
