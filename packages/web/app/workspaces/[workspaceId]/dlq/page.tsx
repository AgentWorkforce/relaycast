import { Header } from "@/app/components/Header";
import { requireWorkspacePageContext } from "@/lib/proactive-runtime/dashboard";
import { WorkspaceSurfaceHeader } from "@/components/proactive-runtime/WorkspaceSurfaceHeader";
import { DlqInspector } from "@/components/proactive-runtime/DlqInspector";

type PageProps = {
  params: Promise<{ workspaceId: string }>;
};

export default async function WorkspaceDlqPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const context = await requireWorkspacePageContext(workspaceId);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <WorkspaceSurfaceHeader
          workspaceId={workspaceId}
          workspaceName={context.workspace.name}
          organizationName={context.organizationName}
          title="DLQ Inspector"
          description="Inspect, replay, or purge failed agent events persisted by the gateway."
        />
        <DlqInspector workspaceId={workspaceId} />
      </main>
    </div>
  );
}
