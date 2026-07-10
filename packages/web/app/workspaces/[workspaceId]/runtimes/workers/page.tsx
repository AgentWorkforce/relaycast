import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Header } from "@/app/components/Header";
import { Badge } from "@/app/components/ui/badge";
import { buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { WorkersTable } from "@/components/workers/WorkersTable";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { WorkerRegistry } from "@/lib/workers/registry";

type PageProps = {
  params: Promise<{ workspaceId: string }>;
};

type WorkspaceRuntimeContext = {
  auth: AuthContext;
  workspace: AuthWorkspace;
};

async function requireWorkspaceContext(workspaceId: string): Promise<WorkspaceRuntimeContext> {
  const cookieStore = await cookies();
  const session = readSessionFromRequest(
    { cookies: cookieStore as never },
    getAuthSessionSecret(),
  );

  if (!session) {
    redirect("/");
  }

  const auth = await getAuthContext(session.userId, session.currentWorkspaceId);
  const workspace = auth.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    redirect("/dashboard");
  }

  return { auth, workspace };
}

export default async function WorkersPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const { auth, workspace } = await requireWorkspaceContext(workspaceId);
  const organization =
    auth.organizations.find((candidate) => candidate.id === workspace.organization_id) ??
    auth.currentOrganization;
  const workers = await new WorkerRegistry().listByWorkspace(workspaceId);

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle>Workers</CardTitle>
                <CardDescription>
                  Register self-hosted machines and use online workers as the workspace default runtime.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/workspaces/${encodeURIComponent(workspaceId)}/runtimes`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Runtimes
                </Link>
                <Link
                  href={`/workspaces/${encodeURIComponent(workspaceId)}/runtimes/workers/new`}
                  className={buttonVariants({})}
                >
                  Add worker
                </Link>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
            <Badge variant="info">{workspace.name}</Badge>
            <span>{organization.name}</span>
            <span>{workers.length} worker(s)</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Registered Workers</CardTitle>
            <CardDescription>
              Only online workers can be selected as the default runtime from this table.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <WorkersTable workspaceId={workspaceId} workers={workers} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
