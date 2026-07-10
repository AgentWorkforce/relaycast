import { redirect } from "next/navigation";
import { requireCurrentWorkspaceId } from "@/lib/proactive-runtime/current-workspace";

export default async function AgentsAliasPage() {
  const workspaceId = await requireCurrentWorkspaceId();
  redirect(`/workspaces/${workspaceId}/agents`);
}
