import Link from "next/link";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Header } from "@/app/components/Header";
import { Badge } from "@/app/components/ui/badge";
import { buttonVariants } from "@/app/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/components/ui/card";
import { RuntimeDefaultPicker } from "@/components/workers/RuntimeDefaultPicker";
import { WorkerStatusBadge } from "@/components/workers/WorkerStatusBadge";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { WorkerRegistry } from "@/lib/workers/registry";
import type { RuntimeDescriptor, WorkerRecord } from "@/lib/workers/types";

type PageProps = {
  params: Promise<{ workspaceId: string }>;
};

type WorkspaceRuntimeContext = {
  auth: AuthContext;
  workspace: AuthWorkspace;
};

const DAYTONA_RUNTIME: RuntimeDescriptor = { id: "daytona" };

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

function normalizeRuntimePayload(payload: unknown): RuntimeDescriptor {
  const candidate =
    payload && typeof payload === "object" && !Array.isArray(payload) && "runtime" in payload
      ? (payload as { runtime?: unknown }).runtime
      : payload;

  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return DAYTONA_RUNTIME;
  }

  const runtime = candidate as { id?: unknown; config?: unknown };
  if (typeof runtime.id !== "string" || !runtime.id.trim()) {
    return DAYTONA_RUNTIME;
  }

  return {
    id: runtime.id.trim(),
    config:
      runtime.config && typeof runtime.config === "object" && !Array.isArray(runtime.config)
        ? (runtime.config as RuntimeDescriptor["config"])
        : null,
  };
}

async function getWorkspaceRuntime(workspaceId: string): Promise<RuntimeDescriptor> {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  if (!host) {
    return DAYTONA_RUNTIME;
  }

  const protocol = headerStore.get("x-forwarded-proto") ?? "http";

  try {
    const response = await fetch(
      `${protocol}://${host}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runtime`,
      {
        cache: "no-store",
        headers: {
          cookie: headerStore.get("cookie") ?? "",
        },
      },
    );

    if (!response.ok) {
      return DAYTONA_RUNTIME;
    }

    return normalizeRuntimePayload(await response.json());
  } catch {
    return DAYTONA_RUNTIME;
  }
}

function selectedWorkerId(runtime: RuntimeDescriptor): string | null {
  return runtime.id === "worker" && typeof runtime.config?.workerId === "string"
    ? runtime.config.workerId
    : null;
}

function runtimeLabel(runtime: RuntimeDescriptor, worker: WorkerRecord | null) {
  if (runtime.id !== "worker") {
    return "Daytona (default)";
  }

  if (!worker) {
    return "Worker";
  }

  return worker.displayName || worker.name;
}

export default async function WorkspaceRuntimesPage({ params }: PageProps) {
  const { workspaceId } = await params;
  const { auth, workspace } = await requireWorkspaceContext(workspaceId);
  const organization =
    auth.organizations.find((candidate) => candidate.id === workspace.organization_id) ??
    auth.currentOrganization;
  const [workers, runtime] = await Promise.all([
    new WorkerRegistry().listByWorkspace(workspaceId),
    getWorkspaceRuntime(workspaceId),
  ]);

  const defaultWorkerId = selectedWorkerId(runtime);
  const defaultWorker = defaultWorkerId
    ? workers.find((worker) => worker.id === defaultWorkerId) ?? null
    : null;
  const onlineWorkers = workers.filter((worker) => worker.status === "online");
  const pendingWorkers = workers.filter((worker) => worker.status === "pending");
  const offlineWorkers = workers.filter((worker) => worker.status === "offline");
  const revokedWorkers = workers.filter((worker) => worker.status === "revoked");
  const defaultWorkerStatus = defaultWorker?.status ?? null;
  const defaultWorkerUnavailable =
    runtime.id === "worker" && defaultWorkerStatus !== null && defaultWorkerStatus !== "online";

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <Header />
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Workspace Runtimes</CardTitle>
            <CardDescription>
              Choose where workflows run for this workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
            <Badge variant="info">{workspace.name}</Badge>
            <span>{organization.name}</span>
          </CardContent>
        </Card>

        {defaultWorkerUnavailable ? (
          <div className="rounded-lg border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft)] p-4 text-sm font-medium text-[var(--status-warning)]">
            Default worker is {defaultWorkerStatus}. New workflows will queue for up to 10 minutes.
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle>Current Default Runtime</CardTitle>
                  <CardDescription>
                    Requests without a runtime override use this setting.
                  </CardDescription>
                </div>
                <Badge variant={runtime.id === "worker" ? "success" : "info"}>
                  {runtime.id === "worker" ? "Worker" : "Daytona"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-4">
                <div className="text-sm text-[var(--text-muted)]">Default</div>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <div className="text-2xl font-semibold tracking-tight">
                    {runtimeLabel(runtime, defaultWorker)}
                  </div>
                  {defaultWorker ? <WorkerStatusBadge status={defaultWorker.status} /> : null}
                </div>
                {runtime.id === "worker" && !defaultWorker ? (
                  <p className="mt-2 text-sm text-[var(--status-warning)]">
                    The saved worker could not be found.
                  </p>
                ) : null}
              </div>

              <RuntimeDefaultPicker
                workspaceId={workspaceId}
                currentRuntime={runtime}
                onlineWorkers={onlineWorkers}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Worker Summary</CardTitle>
              <CardDescription>
                Self-hosted machines registered to this workspace.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                  <div className="text-[var(--text-muted)]">Online</div>
                  <div className="text-2xl font-semibold">{onlineWorkers.length}</div>
                </div>
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                  <div className="text-[var(--text-muted)]">Pending</div>
                  <div className="text-2xl font-semibold">{pendingWorkers.length}</div>
                </div>
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                  <div className="text-[var(--text-muted)]">Offline</div>
                  <div className="text-2xl font-semibold">{offlineWorkers.length}</div>
                </div>
                <div className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-soft)] p-3">
                  <div className="text-[var(--text-muted)]">Revoked</div>
                  <div className="text-2xl font-semibold">{revokedWorkers.length}</div>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/workspaces/${encodeURIComponent(workspaceId)}/runtimes/workers`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  Manage workers
                </Link>
                <Link
                  href={`/workspaces/${encodeURIComponent(workspaceId)}/runtimes/workers/new`}
                  className={buttonVariants({})}
                >
                  Add worker
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle>Sandbox Provider</CardTitle>
                <CardDescription>
                  Daytona remains available for cloud-hosted workflow runs.
                </CardDescription>
              </div>
              <Badge variant="default">Placeholder</Badge>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-[var(--text-secondary)]">
            Daytona can be selected as the workspace default while additional sandbox providers are added.
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
