import { loadFeaturedAgents } from "./_lib/agent-catalog";
import { DashboardHomeView } from "./_components/dashboard-home";

export default async function DashboardPage() {
  const featured = await loadFeaturedAgents();
  return <DashboardHomeView featured={featured} />;
}
