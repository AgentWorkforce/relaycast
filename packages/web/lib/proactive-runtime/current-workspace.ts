import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";

export async function requireCurrentWorkspaceId(): Promise<string> {
  const cookieStore = await cookies();
  const session = readSessionFromRequest(
    { cookies: cookieStore as never },
    getAuthSessionSecret(),
  );

  if (!session?.currentWorkspaceId) {
    redirect("/");
  }

  return session.currentWorkspaceId;
}
