import { RelaySessionProvider } from '../../components/RelaySessionProvider';
import { DashboardLayout } from '../../components/DashboardLayout';

export const runtime = 'edge';

export default function CatchAllPage() {
  return (
    <RelaySessionProvider>
      <DashboardLayout />
    </RelaySessionProvider>
  );
}
