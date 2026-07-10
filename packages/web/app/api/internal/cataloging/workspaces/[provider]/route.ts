import { NextRequest, NextResponse } from "next/server";
import { resolveCatalogingServiceAuth } from "@/lib/auth/request-auth";
import { listWorkspaceIntegrationWorkspaceIds } from "@/lib/integrations/workspace-integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATALOGING_WORKSPACE_PROVIDERS = ["github", "linear"] as const;

type CatalogingWorkspaceProvider = (typeof CATALOGING_WORKSPACE_PROVIDERS)[number];

type CatalogingWorkspacesRouteContext = {
  params: Promise<{ provider: string }>;
};

type CatalogingWorkspacesResponse = {
  provider: CatalogingWorkspaceProvider;
  workspaces: string[];
};

type ErrorResponse = {
  error: string;
};

function isCatalogingWorkspaceProvider(
  value: string,
): value is CatalogingWorkspaceProvider {
  return (CATALOGING_WORKSPACE_PROVIDERS as readonly string[]).includes(value);
}

export async function GET(
  request: NextRequest,
  { params }: CatalogingWorkspacesRouteContext,
) {
  const auth = resolveCatalogingServiceAuth(request);
  if (!auth) {
    return NextResponse.json<ErrorResponse>(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { provider } = await params;
  if (!isCatalogingWorkspaceProvider(provider)) {
    return NextResponse.json<ErrorResponse>(
      { error: "Cataloging provider not found" },
      { status: 404 },
    );
  }

  try {
    const workspaces = await listWorkspaceIntegrationWorkspaceIds(provider);
    return NextResponse.json<CatalogingWorkspacesResponse>(
      { provider, workspaces },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("Cataloging workspace discovery failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to list cataloging workspaces" },
      { status: 500 },
    );
  }
}
