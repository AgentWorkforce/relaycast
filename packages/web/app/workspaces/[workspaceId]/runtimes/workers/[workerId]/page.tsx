import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Header } from "@/app/components/Header";
import { Badge } from "@/app/components/ui/badge";
import { buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { CopyableCommand } from "@/components/workers/CopyableCommand";
import { RevokeWorkerButton } from "@/components/workers/RevokeWorkerButton";
import { WorkerStatusBadge } from "@/components/workers/WorkerStatusBadge";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { WorkerRegistry } from "@/lib/workers/registry";
import type { WorkerHostInfo } from "@/lib/workers/types";

type PageProps = {
  params: Promise<{ workspaceId: string; workerId: string }>;
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "Never";
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return "Unknown";
  }

  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hostSummary(hostInfo: WorkerHostInfo) {
  const os =
    stringValue(hostInfo.os) ??
    stringValue(hostInfo.platform) ??
    stringValue(hostInfo.operatingSystem);
  const arch = stringValue(hostInfo.arch) ?? stringValue(hostInfo.architecture);
  const version =
    stringValue(hostInfo.agentRelayVersion) ??
    stringValue(hostInfo.agent_relay_version) ??
    stringValue(hostInfo.cliVersion) ??
    stringValue(hostInfo.version);

  return {
    os: os ?? "Not reported",
    arch: arch ?? "Not reported",
    version: version ?? "Not reported",
  };
}

export default async function WorkerDetailPage({ params }: PageProps) {
  const { workspaceId, workerId } = await params;
  const { auth, workspace } = await requireWorkspaceContext(workspaceId);
  const organization =
    auth.organizations.find((candidate) => candidate.id === workspace.organization_id) ??
    auth.currentOrganization;
  const worker = await new WorkerRegistry().findById(workerId);

  if (!worker || worker.workspaceId !== workspaceId) {
    notFound();
  }

  const summary = hostSummary(worker.hostInfo);
  const workersHref = `/workspaces/${encodeURIComponent(workspaceId)}/runtimes/workers`;

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle>{worker.displayName || worker.name}</CardTitle>
                <CardDescription>
                  Worker details, host metadata, and local diagnostic commands.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link href={workersHref} className={buttonVariants({ variant: "outline" })}>
                  Back to workers
                </Link>
                <WorkerStatusBadge status={worker.status} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
            <Badge variant="info">{workspace.name}</Badge>
            <span>{organization.name}</span>
            <span className="font-mono text-xs">{worker.id}</span>
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Host Info</CardTitle>
                <CardDescription>
                  Reported by the worker during registration and heartbeat updates.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">OS</div>
                    <div className="mt-1 font-medium">{summary.os}</div>
                  </div>
                  <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">Arch</div>
                    <div className="mt-1 font-medium">{summary.arch}</div>
                  </div>
                  <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--text-muted)]">CLI</div>
                    <div className="mt-1 font-medium">{summary.version}</div>
                  </div>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)] p-4 text-sm text-[var(--code-fg)]">
                  <code>{JSON.stringify(worker.hostInfo, null, 2)}</code>
                </pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Local Diagnostics</CardTitle>
                <CardDescription>
                  Run these on the worker host when checking registration or logs.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <CopyableCommand label="Worker status" command="agent-relay worker status" />
                <CopyableCommand label="Follow logs" command="agent-relay worker logs --follow" />
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Registration</CardTitle>
                <CardDescription>Workspace-scoped worker identity.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <div className="text-[var(--text-muted)]">Name</div>
                  <div className="font-medium">{worker.name}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Registered</div>
                  <div className="font-medium">{formatTimestamp(worker.registeredAt)}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Last seen</div>
                  <div className="font-medium">{formatTimestamp(worker.lastSeen)}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Registered by</div>
                  <div className="break-all font-mono text-xs">{worker.registeredBy}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Tags</div>
                  {worker.tags.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {worker.tags.map((tag) => (
                        <Badge key={tag} variant="default" className="normal-case tracking-normal">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="font-medium">None</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Danger Zone</CardTitle>
                <CardDescription>
                  Revoking rotates the token and stops new assignments.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RevokeWorkerButton
                  workerId={worker.id}
                  workerLabel={worker.displayName || worker.name}
                  workersHref={workersHref}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
