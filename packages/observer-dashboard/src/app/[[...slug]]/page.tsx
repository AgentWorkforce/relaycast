import { Suspense } from 'react';
import { RelaySessionProvider } from '../../components/RelaySessionProvider';
import { DashboardLayout } from '../../components/DashboardLayout';
import { ConnectObserverLayout } from '../../components/ConnectObserverLayout';

export const runtime = 'edge';

export default function CatchAllPage({ params }: { params: { slug?: string[] } }) {
  const connectObserver = params.slug?.[0] === 'connect';
  return (
    <Suspense
      fallback={
        <div className="brand-grid min-h-screen flex items-center justify-center">
          <div className="brand-glass flex items-center gap-3 px-5 py-4 text-sm text-[var(--text-secondary)]">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
            Loading observer…
          </div>
        </div>
      }
    >
      <RelaySessionProvider mode={connectObserver ? 'connect' : 'workspace'}>
        {connectObserver ? <ConnectObserverLayout /> : <DashboardLayout />}
      </RelaySessionProvider>
    </Suspense>
  );
}
