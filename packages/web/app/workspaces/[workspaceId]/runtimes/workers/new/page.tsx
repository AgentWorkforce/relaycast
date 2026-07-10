import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Header } from "@/app/components/Header";
import { Badge } from "@/app/components/ui/badge";
import { buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { NewWorkerForm } from "@/components/workers/NewWorkerForm";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { MIN_CLI_VERSION } from "@/lib/workers/onboarding";

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

export default async function NewWorkerPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const { auth, workspace } = await requireWorkspaceContext(workspaceId);
  const organization =
    auth.organizations.find((candidate) => candidate.id === workspace.organization_id) ??
    auth.currentOrganization;
  const workersHref = `/workspaces/${encodeURIComponent(workspaceId)}/runtimes/workers`;

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle>New Worker</CardTitle>
                <CardDescription>
                  Mint a 15-minute token and register a host with agent-relay.
                </CardDescription>
              </div>
              <Link href={workersHref} className={buttonVariants({ variant: "outline" })}>
                Back to workers
              </Link>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
            <Badge variant="info">{workspace.name}</Badge>
            <span>{organization.name}</span>
            <span>Requires agent-relay CLI {MIN_CLI_VERSION} or later.</span>
          </CardContent>
        </Card>

        <NewWorkerForm
          workspaceId={workspaceId}
          workersHref={workersHref}
          minCliVersion={MIN_CLI_VERSION}
        />
      </main>
    </div>
  );
}
