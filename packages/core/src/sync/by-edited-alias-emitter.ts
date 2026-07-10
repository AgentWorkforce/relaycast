// `by-edited/<YYYY-MM-DD>/` alias emission for confluence / jira / github /
// linear / notion. Extracted from PR #697 (which was superseded by #738 for
// digest but whose by-edited contribution remained undelivered).
//
// CLOUD-SIDE STAND-IN — must be removed/guarded once the adapters own this.
// `by-edited/<YYYY-MM-DD>/` alias generation is contractually the home of
// `@relayfile/adapter-*` (tracked upstream as relayfile#162). At the pinned
// adapter versions (adapter-notion ^0.2.9, adapter-linear ^0.2.7,
// adapter-github ^0.2.7, adapter-jira ^0.2.10, adapter-confluence ^0.1.9,
// sdk ^0.7.15) the adapters do NOT emit a `by-edited` tree — the token only
// appears as a doc-example string in `@relayfile/sdk` types. So this generator
// is a deliberate cloud-side stand-in to satisfy the spec until the adapters
// ship native `by-edited` emission.
//
// FOLLOW-UP (relayfile#162): when an upgraded `@relayfile/adapter-*` begins
// emitting `by-edited/<date>/`, BOTH cloud and the adapter would write the
// same tree (double-emission / path drift). Before that adapter bump lands,
// this generator must be deleted or feature-guarded so cloud yields ownership.
// The idempotency guard in `tests/by-edited-aliases.test.ts` pins the
// no-double-write invariant so an adapter that starts emitting the same tree
// fails loudly.
//
// Path-template contract (intentionally hand-rolled, not derived from adapter
// path-mapper exports): `canonicalPath` IS derived from the adapter mappers,
// so alias→record resolution stays correct even if the adapters change
// canonical layout. Only the alias *directory* leaf is hand-rolled
// (`<root>/by-edited/<date>/<leaf>.json`). That layout is the cloud-owned
// stand-in convention.

import {
  isDeletedNangoRecord,
  parseGitHubRepoFromRecord,
  stripNangoMetadata,
  type RelayfileWriteClient,
} from "./record-writer.js";
import type { NangoSyncJob } from "./nango-sync-job.js";
import {
  computeLinearPath,
  linearByUuidAliasPath,
  normalizeNangoLinearModel,
} from "@relayfile/adapter-linear/path-mapper";
import {
  computeJiraPath,
  jiraIssueByIdAliasPath,
  normalizeJiraObjectType,
} from "@relayfile/adapter-jira/path-mapper";
import {
  confluencePageByIdAliasPath,
  confluencePagePath,
  normalizeNangoConfluenceModel,
} from "@relayfile/adapter-confluence/path-mapper";
import {
  notionByIdAliasPath,
  notionStandalonePagePath,
  normalizeNangoNotionModel,
} from "@relayfile/adapter-notion";
import {
  githubByIdAliasPath,
  githubIssuePath,
  githubPullRequestPath,
  normalizeNangoGitHubModel,
} from "@relayfile/adapter-github/path-mapper";

// Re-export of `EmitAuxiliaryFilesResult["errors"]` shape used by the
// per-provider aux emitters in record-writer.ts. Kept structurally identical
// so callers can splice these errors into their own `errors[]` without a
// shape mismatch.
export type ByEditedEmitError = { path: string; error: string };

const BY_EDITED_JSON_CONTENT_TYPE = "application/json; charset=utf-8";

type ByEditedAliasPlan = {
  stableAliasPath: string;
  aliasPath: string;
  canonicalPath: string;
  editedDate: string;
  objectId: string;
  objectType: string;
  provider: string;
  title?: string;
};

// Public entry point. Call this from each provider's `writeXAuxiliaryFiles`
// AFTER the existing per-record loop has run (so canonical writes have
// already landed). Per-record exception isolation is built in — a throw on
// any single record's by-edited write is captured into `errors[]` and the
// loop continues to the next record. Same shape as PR #829's per-record
// isolation pattern in `writeGoogleMailAuxiliaryFiles`.
export async function writeByEditedAliases(
  client: RelayfileWriteClient,
  records: readonly Record<string, unknown>[],
  job: NangoSyncJob,
): Promise<ByEditedEmitError[]> {
  const errors: ByEditedEmitError[] = [];

  for (const raw of records) {
    try {
      const currentPlan = buildByEditedAliasPlan(raw, job);
      const stableAliasPath =
        currentPlan?.stableAliasPath ?? byEditedStableAliasPath(raw, job);
      const prior = stableAliasPath
        ? await readJsonObjectFile(client, job.workspaceId, stableAliasPath)
        : null;
      const priorPayload = prior ? readAliasPayload(prior) : null;
      const priorPlan = priorPayload
        ? buildByEditedAliasPlan(priorPayload, job)
        : null;

      if (isDeletedNangoRecord(raw)) {
        if (priorPlan) {
          await deleteManagedFile(client, job.workspaceId, priorPlan.aliasPath);
        }
        continue;
      }

      if (!currentPlan) {
        continue;
      }

      if (priorPlan && priorPlan.aliasPath !== currentPlan.aliasPath) {
        await deleteManagedFile(client, job.workspaceId, priorPlan.aliasPath);
      }

      await writeManagedFile({
        client,
        workspaceId: job.workspaceId,
        path: currentPlan.aliasPath,
        content: renderByEditedAlias(currentPlan),
        contentType: BY_EDITED_JSON_CONTENT_TYPE,
      });
    } catch (error) {
      const aliasPath = byEditedStableAliasPath(raw, job);
      errors.push({
        path: aliasPath ?? "(unknown by-edited alias)",
        error: error instanceof Error ? error.message : String(error),
      });
      console.error("[by-edited-alias-emitter] per-record alias emit failed", {
        area: "nango-sync-worker",
        provider: job.provider,
        model: job.model,
        syncName: job.syncName,
        workspaceId: job.workspaceId,
        stableAliasPath: aliasPath,
        stack: error instanceof Error ? error.stack : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return errors;
}

function buildByEditedAliasPlan(
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): ByEditedAliasPlan | null {
  if (isDeletedNangoRecord(raw)) return null;
  const provider = job.provider.trim().toLowerCase();
  const record = stripNangoMetadata(raw);

  if (provider === "notion") return buildNotionByEditedAliasPlan(record, job);
  if (provider === "linear") return buildLinearByEditedAliasPlan(record, job);
  if (provider === "github") return buildGitHubByEditedAliasPlan(record, job);
  if (provider === "jira") return buildJiraByEditedAliasPlan(record, job);
  if (provider === "confluence") return buildConfluenceByEditedAliasPlan(record, job);
  return null;
}

function byEditedStableAliasPath(
  raw: Record<string, unknown>,
  job: NangoSyncJob,
): string | null {
  const provider = job.provider.trim().toLowerCase();
  const record = stripNangoMetadata(raw);

  if (provider === "notion") {
    const id = readId(record);
    return id && safeNotionObjectType(job.model) === "page"
      ? notionByIdAliasPath("/notion/pages", id)
      : null;
  }
  if (provider === "linear") {
    const id = readId(record);
    return id && safeLinearObjectType(job.model) === "issue"
      ? linearByUuidAliasPath("/linear/issues", id)
      : null;
  }
  if (provider === "github") {
    const info = parseGitHubRepoFromRecord(record);
    const type = safeGitHubObjectType(job.model);
    const number = readIntegerLike(record, "number");
    if (!info || !number || (type !== "issue" && type !== "pull_request")) {
      return null;
    }
    return githubByIdAliasPath(
      info.owner,
      info.repo,
      type === "pull_request" ? "pulls" : "issues",
      number,
    );
  }
  if (provider === "jira") {
    const id = readId(record);
    return id && safeJiraObjectType(job.model) === "issue"
      ? jiraIssueByIdAliasPath(id)
      : null;
  }
  if (provider === "confluence") {
    const id = readId(record);
    return id && safeConfluenceObjectType(job.model) === "page"
      ? confluencePageByIdAliasPath(id)
      : null;
  }
  return null;
}

function buildNotionByEditedAliasPlan(
  record: Record<string, unknown>,
  job: NangoSyncJob,
): ByEditedAliasPlan | null {
  if (safeNotionObjectType(job.model) !== "page") return null;
  const id = readId(record);
  const editedDate = readEditedDate(record);
  if (!id || !editedDate) return null;
  const title = readFirstString(record, "title", "name") ?? undefined;
  return {
    provider: "notion",
    objectType: "page",
    objectId: id,
    title,
    editedDate,
    stableAliasPath: notionByIdAliasPath("/notion/pages", id),
    aliasPath: `/notion/pages/by-edited/${editedDate}/${encodePathLeaf(id)}.json`,
    canonicalPath: notionStandalonePagePath(id),
  };
}

function buildLinearByEditedAliasPlan(
  record: Record<string, unknown>,
  job: NangoSyncJob,
): ByEditedAliasPlan | null {
  if (safeLinearObjectType(job.model) !== "issue") return null;
  const id = readId(record);
  const editedDate = readEditedDate(record);
  if (!id || !editedDate) return null;
  const identifier = readFirstString(record, "identifier");
  const title = readFirstString(record, "title") ?? undefined;
  const leaf = identifier ?? id;
  return {
    provider: "linear",
    objectType: "issue",
    objectId: id,
    title,
    editedDate,
    stableAliasPath: linearByUuidAliasPath("/linear/issues", id),
    aliasPath: `/linear/issues/by-edited/${editedDate}/${encodePathLeaf(leaf)}.json`,
    canonicalPath: computeLinearPath("issue", id, identifier ?? title),
  };
}

function buildGitHubByEditedAliasPlan(
  record: Record<string, unknown>,
  job: NangoSyncJob,
): ByEditedAliasPlan | null {
  const type = safeGitHubObjectType(job.model);
  if (type !== "issue" && type !== "pull_request") return null;
  const repoInfo = parseGitHubRepoFromRecord(record);
  const number = readIntegerLike(record, "number");
  const editedDate = readEditedDate(record);
  if (!repoInfo || !number || !editedDate) return null;
  const title = readFirstString(record, "title", "name") ?? undefined;
  const aliasKind = type === "pull_request" ? "pulls" : "issues";
  return {
    provider: "github",
    objectType: type,
    objectId: number,
    title,
    editedDate,
    stableAliasPath: githubByIdAliasPath(
      repoInfo.owner,
      repoInfo.repo,
      aliasKind,
      number,
    ),
    aliasPath: `/github/repos/${encodePathLeaf(repoInfo.owner)}__${encodePathLeaf(
      repoInfo.repo,
    )}/${aliasKind}/by-edited/${editedDate}/${encodePathLeaf(number)}.json`,
    canonicalPath:
      type === "pull_request"
        ? githubPullRequestPath(repoInfo.owner, repoInfo.repo, number, title)
        : githubIssuePath(repoInfo.owner, repoInfo.repo, number, title),
  };
}

function buildJiraByEditedAliasPlan(
  record: Record<string, unknown>,
  job: NangoSyncJob,
): ByEditedAliasPlan | null {
  if (safeJiraObjectType(job.model) !== "issue") return null;
  const id = readId(record);
  const editedDate = readEditedDate(record);
  if (!id || !editedDate) return null;
  const fields = readNestedRecord(record, "fields");
  const title =
    (fields ? readFirstString(fields, "summary") : null) ??
    readFirstString(record, "key") ??
    undefined;
  return {
    provider: "jira",
    objectType: "issue",
    objectId: id,
    title,
    editedDate,
    stableAliasPath: jiraIssueByIdAliasPath(id),
    aliasPath: `/jira/issues/by-edited/${editedDate}/${encodePathLeaf(
      readFirstString(record, "key") ?? id,
    )}.json`,
    canonicalPath: computeJiraPath("issue", id, title),
  };
}

function buildConfluenceByEditedAliasPlan(
  record: Record<string, unknown>,
  job: NangoSyncJob,
): ByEditedAliasPlan | null {
  if (safeConfluenceObjectType(job.model) !== "page") return null;
  const id = readId(record);
  const editedDate = readConfluenceEditedDate(record);
  if (!id || !editedDate) return null;
  const title = readFirstString(record, "title") ?? undefined;
  const spaceId = readFirstString(record, "spaceId", "space_id") ?? undefined;
  return {
    provider: "confluence",
    objectType: "page",
    objectId: id,
    title,
    editedDate,
    stableAliasPath: confluencePageByIdAliasPath(id),
    aliasPath: `/confluence/pages/by-edited/${editedDate}/${encodePathLeaf(id)}.json`,
    canonicalPath: confluencePagePath(id, title, spaceId),
  };
}

function renderByEditedAlias(plan: ByEditedAliasPlan): string {
  return `${JSON.stringify(
    {
      id: plan.objectId,
      provider: plan.provider,
      objectType: plan.objectType,
      editedDate: plan.editedDate,
      canonicalPath: plan.canonicalPath,
      ...(plan.title ? { title: plan.title } : {}),
    },
    null,
    2,
  )}\n`;
}

function readAliasPayload(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  const payload = readNestedRecord(record, "payload");
  return payload ?? record;
}

function readEditedDate(record: Record<string, unknown>): string | null {
  // Falls back to created-at when no edited timestamp exists, so a
  // never-edited record still gets a `by-edited/` alias keyed on its
  // creation date (intentional: keeps day-specific lookup complete for
  // fresh records).
  const direct = readFirstString(
    record,
    "lastEditedTime",
    "last_edited_time",
    "updatedAt",
    "updated_at",
    "editedAt",
    "edited_at",
    "createdAt",
    "created_at",
  );
  const fields = readNestedRecord(record, "fields");
  const fieldDate = fields
    ? readFirstString(fields, "updated", "updatedAt", "updated_at")
    : null;
  const version = readNestedRecord(record, "version");
  const versionDate = version
    ? readFirstString(version, "createdAt", "created_at", "when")
    : null;
  const value = direct ?? fieldDate ?? versionDate;
  return value ? isoDatePart(value) : null;
}

function readConfluenceEditedDate(
  record: Record<string, unknown>,
): string | null {
  const version = readNestedRecord(record, "version");
  const versionDate = version
    ? readFirstString(version, "createdAt", "created_at", "when")
    : null;
  const fallback = readFirstString(
    record,
    "lastEditedTime",
    "last_edited_time",
    "updatedAt",
    "updated_at",
    "editedAt",
    "edited_at",
    "createdAt",
    "created_at",
  );
  const value = versionDate ?? fallback;
  return value ? isoDatePart(value) : null;
}

function isoDatePart(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match?.[1] ?? null;
}

function readIntegerLike(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function encodePathLeaf(value: string): string {
  return encodeURIComponent(value);
}

function safeGitHubObjectType(model: string): string | null {
  try {
    return normalizeNangoGitHubModel(model);
  } catch {
    return null;
  }
}

function safeLinearObjectType(model: string): string | null {
  try {
    return normalizeNangoLinearModel(model);
  } catch {
    return null;
  }
}

function safeNotionObjectType(model: string): string | null {
  try {
    return normalizeNangoNotionModel(model);
  } catch {
    return null;
  }
}

function safeJiraObjectType(model: string): string | null {
  try {
    return normalizeJiraObjectType(model);
  } catch {
    return null;
  }
}

function safeConfluenceObjectType(model: string): string | null {
  try {
    return normalizeNangoConfluenceModel(model);
  } catch {
    return null;
  }
}

// Tiny helpers duplicated here so this module doesn't add new exports from
// record-writer.ts. Kept private; mirrored against `record-writer.ts` to
// preserve behavior parity.

function readId(record: Record<string, unknown>, key = "id"): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readFirstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Local managed-file wrappers — mirror the semantics of `writeManagedFile`
// and `deleteManagedFile` from record-writer.ts (read-then-write dedup,
// 404-tolerant delete) without exporting those internals.
async function readJsonObjectFile(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  if (!client.readFile) return null;
  try {
    const value = await client.readFile(workspaceId, path);
    const content =
      typeof value === "string" ? value : (value as { content?: string }).content;
    if (typeof content !== "string") return null;
    try {
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function writeManagedFile(input: {
  client: RelayfileWriteClient;
  workspaceId: string;
  path: string;
  content: string;
  contentType: string;
}): Promise<void> {
  if (input.client.readFile) {
    try {
      const existing = await input.client.readFile(
        input.workspaceId,
        input.path,
      );
      const existingContent =
        typeof existing === "string"
          ? existing
          : (existing as { content?: string }).content;
      if (existingContent === input.content) {
        return; // byte-identical dedup
      }
    } catch {
      // not-found / network error → fall through to writeFile
    }
  }

  await input.client.writeFile({
    workspaceId: input.workspaceId,
    path: input.path,
    content: input.content,
    contentType: input.contentType,
    encoding: "utf-8",
    baseRevision: "*",
  });
}

async function deleteManagedFile(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<void> {
  try {
    await client.deleteFile({
      workspaceId,
      path,
      baseRevision: "*",
    });
  } catch (error) {
    const status =
      error && typeof error === "object"
        ? (error as { status?: number; statusCode?: number }).status ??
          (error as { status?: number; statusCode?: number }).statusCode
        : undefined;
    if (status !== 404) {
      throw error;
    }
  }
}
