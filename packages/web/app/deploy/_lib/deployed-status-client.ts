import { toAppPath } from "@/lib/app-path";

/**
 * Already-deployed detection for the wizard: when a signed-in user lands on
 * /deploy?persona=… and that persona is already running in their current
 * workspace, the Review step shows a calm informational notice (never a
 * blocker — deploying again stays an explicit user choice).
 */

export interface DeployedAgentMatch {
  agentId: string;
  deployedName: string;
  status: string;
  createdAt: string;
  lastFiredAt: string | null;
}

/**
 * Fetch agents in the workspace already running this persona.
 *
 * Returns `null` on any failure (unauthenticated, network, malformed
 * payload wrapper) — callers render nothing; this surface must never become
 * an error state. Returns `[]` when the lookup succeeded and found nothing.
 *
 * The deployments list route already filters by `personaId` (matched
 * against `agents.deployed_name`, which deploy sets to the persona spec id)
 * and excludes `destroyed` rows by default; the local filter re-asserts
 * both so API drift can't surface wrong-persona or destroyed rows.
 */
export async function fetchAlreadyDeployedAgents(
  workspaceId: string,
  personaSlug: string,
): Promise<DeployedAgentMatch[] | null> {
  if (!workspaceId || !personaSlug) return null;
  try {
    const response = await fetch(
      toAppPath(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments?personaId=${encodeURIComponent(personaSlug)}`,
      ),
      { cache: "no-store", credentials: "include" },
    );
    if (!response.ok) return null;

    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const agents = (payload as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) return null;

    return filterDeployedMatches(agents, personaSlug);
  } catch {
    return null;
  }
}

/** Pure match filter, exported for unit tests. */
export function filterDeployedMatches(
  entries: unknown[],
  personaSlug: string,
): DeployedAgentMatch[] {
  return entries.filter(isDeployedAgentEntry).filter(
    (entry) => entry.deployedName === personaSlug && entry.status !== "destroyed",
  );
}

function isDeployedAgentEntry(value: unknown): value is DeployedAgentMatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.agentId === "string" &&
    typeof record.deployedName === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    (record.lastFiredAt === null || typeof record.lastFiredAt === "string" || record.lastFiredAt === undefined)
  );
}

/**
 * Compact relative time for "deployed 2h ago". Local to the wizard so the
 * standalone /deploy page doesn't import dashboard internals.
 */
export function formatDeployedRelative(iso: string): string {
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "earlier";

  const deltaMinutes = Math.round((Date.now() - timestamp) / 60_000);
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  if (deltaDays < 30) return `${deltaDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
