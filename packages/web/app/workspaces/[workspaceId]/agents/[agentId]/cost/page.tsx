import { Header } from "@/app/components/Header";
import { requireWorkspacePageContext } from "@/lib/proactive-runtime/dashboard";
import { WorkspaceSurfaceHeader } from "@/components/proactive-runtime/WorkspaceSurfaceHeader";
import { AgentCostPanel } from "@/components/proactive-runtime/AgentCostPanel";

type PageProps = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

export default async function WorkspaceAgentCostPage({ params }: PageProps) {
  const { workspaceId, agentId } = await params;
  const context = await requireWorkspacePageContext(workspaceId);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <WorkspaceSurfaceHeader
          workspaceId={workspaceId}
          workspaceName={context.workspace.name}
          organizationName={context.organizationName}
          title="Agent Cost"
          description={`Burn-style cost samples and token totals attributed to ${agentId}.`}
        />
        <AgentCostPanel workspaceId={workspaceId} agentId={agentId} />
      </main>
    </div>
  );
}
