'use client';

import { AuthGate } from '../../components/AuthGate';
import { DashboardLayout } from '../../components/DashboardLayout';

export default function CatchAllPage() {
  return (
    <AuthGate>
      <DashboardLayout />
    </AuthGate>
  );
}
