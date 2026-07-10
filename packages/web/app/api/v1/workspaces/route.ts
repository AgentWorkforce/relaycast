import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import {
  readBearerTokenFromRequest,
  readConfiguredCloudApiToken,
} from "@/lib/integrations/slack-proxy-auth";
import { listSlackWorkspaceSummaries } from "@/lib/integrations/workspace-integrations";
import { normalizeWorkspacePermissions } from "@/lib/relay-workspaces";
import {
  createCloudWorkspaceRegistry,
  formatWorkspaceResponse,
} from "@/lib/workspace-registry";

type CreateWorkspaceBody = {
  name?: string;
  permissions?: {
    ignored?: string[];
    readonly?: string[];
  };
};

type LoginWorkspaceSummary = {
  id: string;
  slug: string;
  name: string;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCreateWorkspaceBody(payload: unknown): payload is CreateWorkspaceBody {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const body = payload as Partial<CreateWorkspaceBody>;
  if (body.name !== undefined && typeof body.name !== "string") {
    return false;
  }

  if (body.permissions === undefined) {
    return true;
  }

  if (
    !body.permissions ||
    typeof body.permissions !== "object" ||
    Array.isArray(body.permissions)
  ) {
    return false;
  }

  return (
    (body.permissions.ignored === undefined || isStringArray(body.permissions.ignored)) &&
    (body.permissions.readonly === undefined || isStringArray(body.permissions.readonly))
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function authenticateCloudApiRequest(
  request: NextRequest,
): { ok: true } | { ok: false; status: 401 | 403 } {
  const providedToken = readBearerTokenFromRequest(request);
  if (!providedToken) {
    return { ok: false, status: 401 };
  }
  const expectedToken = readConfiguredCloudApiToken();
  if (!expectedToken || !constantTimeEqual(providedToken, expectedToken)) {
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

function formatLoginWorkspaceSummary(workspace: {
  id: string;
  slug?: string | null;
  name?: string | null;
}): LoginWorkspaceSummary {
  return {
    id: workspace.id,
    slug: workspace.slug || workspace.id,
    name: workspace.name || workspace.slug || workspace.id,
  };
}

function listLoginWorkspaces(auth: RequestAuth): LoginWorkspaceSummary[] {
  if (requireSessionAuth(auth)) {
    const currentOrganizationId = auth.context.currentOrganization.id;
    const workspaces = auth.context.workspaces.filter(
      (workspace) => workspace.organization_id === currentOrganizationId,
    );

    if (workspaces.length > 0) {
      return workspaces.map(formatLoginWorkspaceSummary);
    }
  }

  return [
    formatLoginWorkspaceSummary({
      id: auth.workspaceId,
      slug: auth.context?.currentWorkspace?.slug,
      name: auth.context?.currentWorkspace?.name,
    }),
  ];
}

async function listIntegrationWorkspaces(request: NextRequest, integration: string) {
  const auth = authenticateCloudApiRequest(request);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 401 ? "Unauthorized" : "Forbidden" },
      { status: auth.status },
    );
  }

  if (integration !== "slack") {
    return NextResponse.json(
      { error: `Unsupported integration: ${integration}` },
      { status: 400 },
    );
  }

  try {
    const workspaces = await listSlackWorkspaceSummaries();
    return NextResponse.json({ workspaces });
  } catch (error) {
    console.error(
      "Failed to list workspaces by integration:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to list workspaces" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  const integration = new URL(request.url).searchParams.get("integration")?.trim();
  if (integration) {
    return listIntegrationWorkspaces(request, integration);
  }

  const auth = await resolveRequestAuth(request);
  const credentialsProvided = !!request.headers.get("authorization");

  if (!auth && credentialsProvided) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ workspaces: listLoginWorkspaces(auth) });
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  const credentialsProvided = !!request.headers.get("authorization");

  // Credentials were provided but failed to resolve — reject rather than
  // silently downgrading to anonymous.
  if (!auth && credentialsProvided) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated users must have session auth or cli:auth scope
  if (auth && !requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown = {};
  try {
    const raw = await request.text();
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isCreateWorkspaceBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const { registry, serviceConfig } = createCloudWorkspaceRegistry();
    const workspace = await registry.create({
      name: body.name?.trim() || undefined,
      createdBy: auth?.userId ?? "00000000-0000-0000-0000-000000000000",
      permissions: normalizeWorkspacePermissions(body.permissions),
    });

    return NextResponse.json(
      formatWorkspaceResponse(workspace, serviceConfig),
      { status: 201 },
    );
  } catch (error) {
    console.error("Unified workspace creation failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Failed to create workspace" }, { status: 500 });
  }
}
