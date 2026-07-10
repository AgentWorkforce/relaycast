import { redirect } from "next/navigation";

type WorkflowRunRedirectPageProps = {
  params: Promise<{ runId: string }>;
};

export default async function WorkflowRunRedirectPage({ params }: WorkflowRunRedirectPageProps) {
  const { runId } = await params;
  redirect(`/dashboard/workflow/${encodeURIComponent(runId)}/runner`);
}
