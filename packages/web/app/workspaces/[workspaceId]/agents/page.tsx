import { Header } from "@/app/components/Header";
import { requireWorkspacePageContext } from "@/lib/proactive-runtime/dashboard";
import { WorkspaceSurfaceHeader } from "@/components/proactive-runtime/WorkspaceSurfaceHeader";
import { AgentsOverview } from "@/components/proactive-runtime/AgentsOverview";

type PageProps = {
  params: Promise<{ workspaceId: string }>;
};

export default async function WorkspaceAgentsPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const context = await requireWorkspacePageContext(workspaceId);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8">
        <WorkspaceSurfaceHeader
          workspaceId={workspaceId}
          workspaceName={context.workspace.name}
          organizationName={context.organizationName}
          title="Proactive Agents"
          description="Workspace-scoped runtime inventory for deployed agents, policies, and activity."
        />
        <AgentsOverview workspaceId={workspaceId} />
      </main>
    </div>
  );
}
