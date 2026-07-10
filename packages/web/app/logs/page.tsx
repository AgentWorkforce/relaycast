import { redirect } from "next/navigation";
import { requireCurrentWorkspaceId } from "@/lib/proactive-runtime/current-workspace";

export default async function LogsAliasPage() {
  const workspaceId = await requireCurrentWorkspaceId();
  redirect(`/workspaces/${workspaceId}/logs`);
}
