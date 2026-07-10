import { redirect } from "next/navigation";
import { requireCurrentWorkspaceId } from "@/lib/proactive-runtime/current-workspace";

type PageProps = {
  params: Promise<{ agentId: string }>;
};

export default async function AgentCostAliasPage({ params }: PageProps) {
  const workspaceId = await requireCurrentWorkspaceId();
  const { agentId } = await params;
  redirect(`/workspaces/${workspaceId}/agents/${agentId}/cost`);
}
