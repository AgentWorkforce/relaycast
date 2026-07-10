import { sql } from "drizzle-orm";
import { parsePostgresTextArray } from "@cloud/core/db/postgres-array.js";
import { getDb } from "@/lib/db";

export type InboxDeploymentCandidate = {
  id: string;
  deployed_name: string | null;
  inbox_selectors: string[] | null;
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function normalizeSelector(value: string): string {
  const trimmed = value.trim();
  return trimmed === "@self" ? trimmed : trimmed.replace(/^#/, "");
}

export async function readInboxDeploymentCandidates(input: {
  workspaceId: string;
  selector: string;
}): Promise<InboxDeploymentCandidate[]> {
  const selector = normalizeSelector(input.selector);
  const result = await getDb().execute(sql`
    SELECT
      agents.id,
      agents.deployed_name,
      agents.inbox_selectors
    FROM agents
    WHERE agents.workspace_id = ${input.workspaceId}
      AND agents.status = 'active'
      AND ${selector} = ANY(COALESCE(agents.inbox_selectors, ARRAY[]::text[]))
  `);
  return rowsOf<InboxDeploymentCandidate>(result).map((row) => ({
    ...row,
    inbox_selectors: parsePostgresTextArray(row.inbox_selectors) ?? null,
  }));
}
