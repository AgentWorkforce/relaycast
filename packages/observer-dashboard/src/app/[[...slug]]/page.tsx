import { Suspense } from 'react';
import { RelaySessionProvider } from '../../components/RelaySessionProvider';
import { DashboardLayout } from '../../components/DashboardLayout';

export const runtime = 'edge';

export default function CatchAllPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="animate-spin h-8 w-8 border-2 border-indigo-500 border-t-transparent rounded-full" /></div>}>
      <RelaySessionProvider>
        <DashboardLayout />
      </RelaySessionProvider>
    </Suspense>
  );
}
