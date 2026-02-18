'use client';

import { RelaySessionProvider } from '../../components/RelaySessionProvider';
import { DashboardLayout } from '../../components/DashboardLayout';

export default function CatchAllPage() {
  return (
    <RelaySessionProvider>
      <DashboardLayout />
    </RelaySessionProvider>
  );
}
