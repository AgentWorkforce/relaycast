import { WorkflowRunPageView } from "../../../_components/dashboard-views";

type WorkflowRunRunnerPageProps = {
  params: Promise<{ runId: string }>;
};

export default async function WorkflowRunRunnerPage({ params }: WorkflowRunRunnerPageProps) {
  const { runId } = await params;
  return <WorkflowRunPageView runId={runId} />;
}
