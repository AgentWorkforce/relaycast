import { and, eq, ne } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import {
  ACTIVE_CREDENTIAL_CONSTRAINT,
  isActiveCredentialConflict,
} from "@/lib/integrations/provider-credential-errors";

type RouteContext = {
  params: Promise<{ agentId: string }>;
};

export type CloudAgentActivateRouteDeps = {
  resolveRequestAuth: typeof resolveRequestAuth;
  requireSessionAuth: typeof requireSessionAuth;
  requireAuthScope: typeof requireAuthScope;
  getDb: typeof getDb;
};

const defaultDeps: CloudAgentActivateRouteDeps = {
  resolveRequestAuth,
  requireSessionAuth,
  requireAuthScope,
  getDb,
};

function isMissingProviderCredentialsTable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('relation "provider_credentials" does not exist')
  );
}

export function createCloudAgentActivateRouteHandlers(
  deps: CloudAgentActivateRouteDeps = defaultDeps,
) {
  async function POST(request: NextRequest, { params }: RouteContext) {
    const auth = await deps.resolveRequestAuth(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      !deps.requireSessionAuth(auth) &&
      !deps.requireAuthScope(auth, "cli:auth")
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { agentId } = await params;

    try {
      const db = deps.getDb();
      const [target] = await db
        .select({
          id: providerCredentials.id,
          modelProvider: providerCredentials.modelProvider,
          isActive: providerCredentials.isActive,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, agentId),
            eq(providerCredentials.userId, auth.userId),
            eq(providerCredentials.workspaceId, auth.workspaceId),
          ),
        )
        .limit(1);

      if (!target) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      if (!target.isActive) {
        const now = new Date();
        // Deactivate-then-activate inside one transaction so the
        // provider_credentials_one_active_per_provider partial unique index
        // never sees two active rows in the (user, workspace, provider)
        // group, even under concurrent activations.
        await db.transaction(async (tx) => {
          await tx
            .update(providerCredentials)
            .set({ isActive: false, updatedAt: now })
            .where(
              and(
                eq(providerCredentials.userId, auth.userId),
                eq(providerCredentials.workspaceId, auth.workspaceId),
                eq(providerCredentials.modelProvider, target.modelProvider),
                eq(providerCredentials.isActive, true),
                ne(providerCredentials.id, target.id),
              ),
            );
          await tx
            .update(providerCredentials)
            .set({ isActive: true, updatedAt: now })
            .where(eq(providerCredentials.id, target.id));
        });
      }

      const group = await db
        .select({
          id: providerCredentials.id,
          modelProvider: providerCredentials.modelProvider,
          isActive: providerCredentials.isActive,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.userId, auth.userId),
            eq(providerCredentials.workspaceId, auth.workspaceId),
            eq(providerCredentials.modelProvider, target.modelProvider),
          ),
        );

      return NextResponse.json({ activatedId: target.id, agents: group });
    } catch (error) {
      if (isMissingProviderCredentialsTable(error)) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      if (isActiveCredentialConflict(error)) {
        console.warn("Cloud agent activation conflict:", {
          agentId,
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          constraint: ACTIVE_CREDENTIAL_CONSTRAINT,
        });
        return NextResponse.json(
          {
            error:
              "Another credential activation completed first. Refresh and try again.",
            code: "active_credential_conflict",
          },
          { status: 409 },
        );
      }

      console.error("Cloud agent activation failed:", error);

      return NextResponse.json(
        { error: "Failed to activate cloud agent" },
        { status: 500 },
      );
    }
  }

  return { POST };
}

const handlers = createCloudAgentActivateRouteHandlers();

export const POST = handlers.POST;
