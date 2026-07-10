import { WorkflowRunPageView } from "../../../../_components/dashboard-views";

type WorkflowRunAgentPageProps = {
  params: Promise<{ runId: string; sandboxId: string }>;
};

export default async function WorkflowRunAgentPage({ params }: WorkflowRunAgentPageProps) {
  const { runId, sandboxId } = await params;
  return <WorkflowRunPageView runId={runId} initialSandboxId={sandboxId} />;
}
