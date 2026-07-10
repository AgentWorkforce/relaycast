import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { workflowRepositoryAllowlists } from "../db/schema";

function normalizeCoord(s: string): string {
  return s.trim().toLowerCase();
}

export type WorkflowRepositoryAllowlistRecord = {
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  installationId: string;
  pushAllowed: boolean;
  allowedAt: Date;
  allowedBy: string;
};

function mapRecord(
  record: typeof workflowRepositoryAllowlists.$inferSelect,
): WorkflowRepositoryAllowlistRecord {
  return {
    workspaceId: record.workspaceId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    installationId: record.installationId,
    pushAllowed: record.pushAllowed,
    allowedAt: record.allowedAt,
    allowedBy: record.allowedBy,
  };
}

export async function listAllowedRepos(
  workspaceId: string,
): Promise<WorkflowRepositoryAllowlistRecord[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(workflowRepositoryAllowlists)
    .where(eq(workflowRepositoryAllowlists.workspaceId, workspaceId))
    .orderBy(
      asc(workflowRepositoryAllowlists.repoOwner),
      asc(workflowRepositoryAllowlists.repoName),
    );

  return records.map(mapRecord);
}

export async function getAllowedRepo(
  workspaceId: string,
  repoOwner: string,
  repoName: string,
): Promise<WorkflowRepositoryAllowlistRecord | null> {
  const db = getDb();
  const ownerNorm = normalizeCoord(repoOwner);
  const nameNorm = normalizeCoord(repoName);
  const [record] = await db
    .select()
    .from(workflowRepositoryAllowlists)
    .where(
      and(
        eq(workflowRepositoryAllowlists.workspaceId, workspaceId),
        eq(workflowRepositoryAllowlists.repoOwner, ownerNorm),
        eq(workflowRepositoryAllowlists.repoName, nameNorm),
      ),
    )
    .limit(1);

  return record ? mapRecord(record) : null;
}

export async function upsertAllowedRepo(input: {
  workspaceId: string;
  repoOwner: string;
  repoName: string;
  installationId: string;
  pushAllowed?: boolean;
  allowedBy: string;
}): Promise<WorkflowRepositoryAllowlistRecord> {
  const db = getDb();
  const timestamp = new Date();
  const ownerNorm = normalizeCoord(input.repoOwner);
  const nameNorm = normalizeCoord(input.repoName);

  const [record] = await db
    .insert(workflowRepositoryAllowlists)
    .values({
      workspaceId: input.workspaceId,
      repoOwner: ownerNorm,
      repoName: nameNorm,
      installationId: input.installationId,
      pushAllowed: input.pushAllowed ?? false,
      allowedAt: timestamp,
      allowedBy: input.allowedBy,
    })
    .onConflictDoUpdate({
      target: [
        workflowRepositoryAllowlists.workspaceId,
        workflowRepositoryAllowlists.repoOwner,
        workflowRepositoryAllowlists.repoName,
      ],
      set: {
        installationId: input.installationId,
        pushAllowed: input.pushAllowed ?? false,
        allowedAt: timestamp,
        allowedBy: input.allowedBy,
      },
    })
    .returning();

  return mapRecord(record);
}

export async function updateAllowedRepoPushAllowed(
  workspaceId: string,
  repoOwner: string,
  repoName: string,
  pushAllowed: boolean,
): Promise<WorkflowRepositoryAllowlistRecord | null> {
  const db = getDb();
  const ownerNorm = normalizeCoord(repoOwner);
  const nameNorm = normalizeCoord(repoName);
  const [record] = await db
    .update(workflowRepositoryAllowlists)
    .set({ pushAllowed })
    .where(
      and(
        eq(workflowRepositoryAllowlists.workspaceId, workspaceId),
        eq(workflowRepositoryAllowlists.repoOwner, ownerNorm),
        eq(workflowRepositoryAllowlists.repoName, nameNorm),
      ),
    )
    .returning();

  return record ? mapRecord(record) : null;
}

// Phase A enforcement (cloud#296) is currently relaxed: any repo the
// workspace's GitHub App can already reach is treated as allowed for
// read+push. The explicit per-repo allowlist table is preserved so we
// can flip back to strict enforcement by setting
// `CLOUD_REPO_ALLOWLIST_ENFORCED=true` without a code revert.
export function isRepoAllowlistEnforced(): boolean {
  return process.env.CLOUD_REPO_ALLOWLIST_ENFORCED === "true";
}

// Resolve a per-repo allowlist record, synthesizing one from the
// workspace's GitHub install when strict enforcement is off. Returns
// null when:
//   - strict enforcement is on AND no row exists, or
//   - relaxed mode is on but the workspace has no GitHub install, or
//   - relaxed mode is on but the workspace's GitHub App install can't
//     actually reach this specific repo (e.g. App installed on a
//     subset of org repos). Without this probe we'd accept the submit
//     and fail in Phase C with a late `github_api_error` after the
//     workflow has already run — the early `repo_not_allowlisted`
//     contract only holds if access is verified up front.
export async function resolveRepoAllowlistOrRelaxed(
  workspaceId: string,
  repoOwner: string,
  repoName: string,
  options?: { fetchImpl?: typeof fetch },
): Promise<WorkflowRepositoryAllowlistRecord | null> {
  const explicit = await getAllowedRepo(workspaceId, repoOwner, repoName);
  if (explicit) return explicit;
  if (isRepoAllowlistEnforced()) {
    console.warn("[allowlist] strict enforcement on, no explicit row for repo", {
      workspaceId,
      repoOwner,
      repoName,
    });
    return null;
  }

  // Relaxed mode is the structural separation of two concerns the
  // resolver used to conflate:
  //
  //   1. Authorization — "is this workspace allowed to push to this
  //      repo?". In strict mode an explicit allowlist row is the
  //      authoritative answer (with the row's installationId hint).
  //      In relaxed mode the answer is always yes if repo coordinates
  //      were supplied.
  //   2. Routing — "which installation should push-back use?". This
  //      belongs in push-back, not here. A workspace can have several
  //      github-* installs; the resolver shouldn't preempt the choice
  //      by picking one. push-back queries the workspace's installs
  //      itself and tries each in order, so a single bad install
  //      can't block the path. See `pushWorkflowPathPatch` in
  //      `github-push-back.ts`.
  //
  // Earlier revisions (cloud#423/#440/#446) had the resolver pick a
  // single install — first by probing `GET /repos/{owner}/{repo}`,
  // later by picking the most-recently-updated row. Both were the
  // wrong layer for that decision. Relaxed mode here is now zero-
  // network: it returns a synthetic record with an empty
  // `installationId` sentinel that tells push-back "no preference,
  // discover and try them all." Strict mode is unchanged: explicit
  // rows still pass through with their `installationId`.
  return {
    workspaceId,
    repoOwner: normalizeCoord(repoOwner),
    repoName: normalizeCoord(repoName),
    installationId: "",
    pushAllowed: true,
    allowedAt: new Date(0),
    allowedBy: "system:relaxed",
  };
}

export async function deleteAllowedRepo(
  workspaceId: string,
  repoOwner: string,
  repoName: string,
): Promise<boolean> {
  const db = getDb();
  const ownerNorm = normalizeCoord(repoOwner);
  const nameNorm = normalizeCoord(repoName);
  const deleted = await db
    .delete(workflowRepositoryAllowlists)
    .where(
      and(
        eq(workflowRepositoryAllowlists.workspaceId, workspaceId),
        eq(workflowRepositoryAllowlists.repoOwner, ownerNorm),
        eq(workflowRepositoryAllowlists.repoName, nameNorm),
      ),
    )
    .returning({ workspaceId: workflowRepositoryAllowlists.workspaceId });

  return deleted.length > 0;
}
