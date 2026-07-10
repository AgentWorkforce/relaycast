import { redirect } from "next/navigation";
import { requireCurrentWorkspaceId } from "@/lib/proactive-runtime/current-workspace";

export default async function DlqAliasPage() {
  const workspaceId = await requireCurrentWorkspaceId();
  redirect(`/workspaces/${workspaceId}/dlq`);
}
