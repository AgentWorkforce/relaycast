'use client';

import { AuthGate } from '../../components/AuthGate';
import { clearAuth } from '../../lib/auth';
import { useRouter } from 'next/navigation';
import { App } from '@agent-relay/dashboard/components/App';

export default function CatchAllPage() {
  const router = useRouter();

  function handleLogout() {
    clearAuth();
    router.push('/login');
  }

  return (
    <AuthGate>
      <div className="min-h-screen flex flex-col">
        <div className="absolute top-3 right-4 z-50">
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 rounded-lg transition-colors bg-black/50 backdrop-blur"
          >
            Sign out
          </button>
        </div>
        <App enableReactions />
      </div>
    </AuthGate>
  );
}
