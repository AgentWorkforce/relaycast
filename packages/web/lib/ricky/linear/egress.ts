import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { rickyRunStore } from "@/lib/ricky/run-store";
import { rickyLinearStore, RICKY_LINEAR_PROVIDER } from "./store";

export type LinearAgentActivity = {
  type: "thought" | "elicitation" | "action" | "response" | "error";
  body?: string;
  action?: string;
  parameter?: string;
  result?: string;
};

export type RickyLinearConnection = {
  connectionId: string;
  providerConfigKey: string;
};

type RawIntegration = {
  connection_id: string;
  provider_config_key: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate.rows) ? candidate.rows : [];
}

async function findLinearRickyWorkspaceIntegration(workspaceId: string): Promise<RickyLinearConnection | null> {
  const result = await getDb().execute(sql`
    SELECT connection_id, provider_config_key
    FROM workspace_integrations
    WHERE workspace_id = ${workspaceId}
      AND provider = ${RICKY_LINEAR_PROVIDER}
    LIMIT 1
  `);
  const row = rowsOf<RawIntegration>(result)[0];
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    providerConfigKey: row.provider_config_key ?? RICKY_LINEAR_PROVIDER,
  };
}

export async function resolveLinearConnection(input: {
  workspaceId?: string;
  linearOrgId?: string;
}): Promise<RickyLinearConnection | null> {
  const installation = input.workspaceId
    ? await rickyLinearStore.findActiveInstallationByWorkspace(input.workspaceId)
    : input.linearOrgId
      ? await rickyLinearStore.findActiveInstallationByOrg(input.linearOrgId)
      : null;
  if (installation) {
    return {
      connectionId: installation.connectionId,
      providerConfigKey: installation.providerConfigKey ?? RICKY_LINEAR_PROVIDER,
    };
  }

  return input.workspaceId ? findLinearRickyWorkspaceIntegration(input.workspaceId) : null;
}

export const rickyLinearEgress = {
  async postAgentActivity(input: {
    workspaceId?: string;
    linearOrgId?: string;
    sessionId: string;
    activity: LinearAgentActivity;
    rickyRunId?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const connection = await resolveLinearConnection({
      workspaceId: input.workspaceId,
      linearOrgId: input.linearOrgId,
    });
    if (!connection) {
      console.warn("[ricky-linear] no Linear connection for AgentActivity", {
        workspaceId: input.workspaceId,
        linearOrgId: input.linearOrgId,
        sessionId: input.sessionId,
      });
      return { ok: false, error: "Ricky Linear installation is not connected." };
    }

    try {
      const { proxyRequest } = await import("@/lib/integrations/nango-slack");
      await proxyRequest<unknown>({
        method: "POST",
        endpoint: "/graphql",
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: {
          query: `
            mutation RickyAgentActivityCreate($input: AgentActivityCreateInput!) {
              agentActivityCreate(input: $input) {
                success
              }
            }
          `,
          variables: {
            input: {
              agentSessionId: input.sessionId,
              content: input.activity,
            },
          },
        },
      });
      if (input.rickyRunId) {
        await rickyRunStore.appendEvent(input.rickyRunId, "linear.agent_activity.posted", {
          sessionId: input.sessionId,
          activity: input.activity,
        });
      }
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ricky-linear] AgentActivity post failed:", message);
      return { ok: false, error: message };
    }
  },
};
