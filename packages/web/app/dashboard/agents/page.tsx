import { loadCatalogAgents } from "../_lib/agent-catalog";
import { AgentCatalogView } from "../_components/agent-catalog-view";

export default async function AgentCatalogPage() {
  const agents = await loadCatalogAgents();
  return <AgentCatalogView agents={agents} />;
}
