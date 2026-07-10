import type { FilesystemEvent } from "@relayfile/sdk";
import type { Row } from "./adapter.js";
import { hashContent } from "./content-hash.js";

const DIGEST_CONTENT_TYPE = "text/markdown; charset=utf-8";
const DIGEST_PROVIDER = "digest";
const DIGEST_ROOT = "/digests/";
const DIGEST_WINDOWS = [
  "today",
  "yesterday",
  "this-week",
  "last-week",
] as const;
const DIGEST_CONTENT_LOAD_CONCURRENCY = 8;
const DIGEST_EVENT_LIMIT = 2_000;
// Verb overrides ("was closed"/"merged") require up to 2 R2 content reads per
// create/update event. Over the full 2,000-event window that fans out thousands
// of reads in a SINGLE digest-refresh alarm invocation, which on a busy
// workspace exceeds the Worker CPU + in-flight subrequest limits (cloud#1251:
// 900s exceededCpu → DO reset → sync-WS 1006). Bound the overrides to the most
// recent N create/update events; older events fall back to the default verb.
const DIGEST_VERB_OVERRIDE_MAX_EVENTS = 200;
const DIGEST_EVENT_CONTENT_MAX_READ_BYTES = 512 * 1024;
const DIGEST_TOTAL_VERB_OVERRIDE_BUDGET_BYTES = 16 * 1024 * 1024;
const DIGEST_TEXT_ENCODER = new TextEncoder();
const DIGEST_ALIAS_SEGMENTS = new Set([
  "by-assignee",
  "by-author",
  "by-calendar",
  "by-conversation",
  "by-creator",
  "by-database",
  "by-day",
  "by-edited",
  "by-id",
  "by-key",
  "by-label",
  "by-name",
  "by-organizer",
  "by-parent",
  "by-participant",
  "by-priority",
  "by-query",
  "by-ref",
  "by-role",
  "by-sender",
  "by-space",
  "by-state",
  "by-status",
  "by-thread",
  "by-title",
  "by-username",
  "by-uuid",
]);

type DigestWindowName = (typeof DIGEST_WINDOWS)[number];
type DigestWindowRequest = DigestWindowName | string;

type DigestWindow = {
  name: string;
  path: string;
  date: LocalDate;
  from: string;
  to: string;
  windowKey: string;
  closed: boolean;
};

type LocalDate = {
  year: number;
  month: number;
  day: number;
};

type DigestEventRow = {
  eventId: string;
  type: string;
  path: string;
  revision: string;
  origin: string;
  provider: string;
  correlationId: string;
  timestamp: string;
  verbOverride?: string;
};

type DigestEventsResult = {
  events: DigestEventRow[];
  truncated: boolean;
  warnings: string[];
};

type VerbOverrideBudget = {
  maxBytes: number;
  loadedBytes: number;
  reservedBytes: number;
};

export interface WorkspaceDigestContext {
  allRows<T extends Row = Row>(query: string, ...bindings: unknown[]): T[];
  sqlExec(query: string, ...bindings: unknown[]): void;
  getFileRow(path: string): {
    revision?: string;
    contentRef?: string;
    updatedAt?: string;
  } | null;
  nextId(prefix: "rev" | "evt" | "op"): string;
  contentRef(workspaceId: string, path: string, revision: string): string;
  putObject(
    contentRef: string,
    content: string,
    encoding: "utf-8" | "base64",
    contentType: string,
    workspaceId: string,
    path: string,
    revision: string,
  ): Promise<void>;
  deleteContent?(contentRef: string): Promise<void> | void;
  loadContent?(
    contentRef: string,
    encoding: "utf-8" | "base64",
    maxBytes?: number,
  ): Promise<string>;
  insertEvent(
    event: {
      eventId: string;
      type: FilesystemEvent["type"];
      path: string;
      revision: string;
      origin: FilesystemEvent["origin"];
      provider?: string;
      correlationId?: string;
      timestamp: string;
    },
    options?: { broadcast?: boolean },
  ): void;
  broadcastEvent?(event: {
    eventId: string;
    type: FilesystemEvent["type"];
    path: string;
    revision: string;
    origin: FilesystemEvent["origin"];
    provider?: string;
    correlationId?: string;
    timestamp: string;
  }): void;
  flushStorage?(): Promise<void>;
}

export function isDigestPath(path: string): boolean {
  return normalizePath(path).startsWith(DIGEST_ROOT);
}

/**
 * Path predicate identifying internal/system files that must NEVER appear in
 * the human-facing workspace activity digest.
 *
 * Why: the digest is bounded by a 2,000-event budget per window. Internal
 * files (the per-directory `.relayfile.acl` permission marker is the worst
 * offender) and provider auxiliary files (`_index.json`, known `by-*` alias
 * directories) churn on large syncs and, when included, exhaust the budget
 * so real provider activity (Linear / Jira / Notion / GitHub / GitLab /
 * Confluence / Slack) gets squeezed out and the digest becomes useless. We
 * filter them BEFORE the cap counts them so the budget is reserved for real
 * activity. The match is path-segment anchored (not substring) so that a
 * provider file merely mentioning "acl" or "layout" in its name (e.g.
 * `/notion/pages/some-acl-doc.json`) is NOT filtered.
 */
export function isInternalDigestPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? "";

  // Per-directory permission markers and root-level system files.
  if (leaf === ".relayfile.acl") return true;
  if (leaf === "LAYOUT.md") return true;
  if (leaf === "_index.json") return true;
  if (normalized === "/.relayfile-mount-state.json") return true;
  if (
    segments.some(
      (segment, index) =>
        index < segments.length - 1 && DIGEST_ALIAS_SEGMENTS.has(segment),
    )
  ) {
    return true;
  }

  // Internal subtrees: discovery surface (PR #761), digest outputs themselves,
  // and skill scratch space.
  const root = segments[0];
  if (root === "discovery") return true;
  if (root === "digests") return true;
  if (root === ".skills") return true;

  return false;
}

export async function refreshWorkspaceDigests(
  context: WorkspaceDigestContext,
  workspaceId: string,
  options: {
    changedPaths?: readonly string[];
    generatedAt?: Date;
    correlationId?: string;
    timeZone?: string;
    windows?: readonly DigestWindowRequest[];
    /**
     * Max recent create/update events that get content-derived verb overrides
     * per refresh (cloud#1251). The rest fall back to the default verb. Defaults
     * to DIGEST_VERB_OVERRIDE_MAX_EVENTS; the DO passes an env-tuned value.
     */
    verbOverrideMaxEvents?: number;
    /**
     * Max total content bytes loaded for verb overrides per refresh. `0`
     * disables the aggregate byte budget; unset uses the built-in default.
     */
    verbOverrideBudgetBytes?: number;
  } = {},
): Promise<void> {
  const changedPaths = options.changedPaths ?? [];
  if (
    changedPaths.length > 0 &&
    changedPaths.every((path) => isDigestPath(path))
  ) {
    return;
  }

  const generatedAt = options.generatedAt ?? new Date();
  const timeZone = normalizeTimeZone(options.timeZone);
  const windows =
    options.windows ?? defaultDigestWindows(generatedAt, timeZone);
  const implicitRefresh = options.windows == null;
  const verbOverrideMaxEvents = Math.max(
    0,
    options.verbOverrideMaxEvents ?? DIGEST_VERB_OVERRIDE_MAX_EVENTS,
  );
  const verbOverrideBudget = createVerbOverrideBudget(
    options.verbOverrideBudgetBytes ?? DIGEST_TOTAL_VERB_OVERRIDE_BUDGET_BYTES,
  );
  for (const windowName of windows) {
    await writeDigestWindow(context, workspaceId, {
      windowName,
      generatedAt,
      timeZone,
      correlationId: options.correlationId ?? "",
      implicitRefresh,
      verbOverrideMaxEvents,
      verbOverrideBudget,
    });
  }
}

async function writeDigestWindow(
  context: WorkspaceDigestContext,
  workspaceId: string,
  input: {
    windowName: DigestWindowRequest;
    generatedAt: Date;
    timeZone: string;
    correlationId: string;
    implicitRefresh: boolean;
    verbOverrideMaxEvents: number;
    verbOverrideBudget: VerbOverrideBudget | null;
  },
): Promise<void> {
  const window = resolveWindow(
    input.windowName,
    input.generatedAt,
    input.timeZone,
  );
  if (!window) {
    return;
  }
  const path = window.path;
  const previous = context.getFileRow(path);
  if (
    input.implicitRefresh &&
    shouldSkipImplicitDigestRefresh(window, previous, input.generatedAt)
  ) {
    return;
  }
  const digestEvents = await readDigestEvents(
    context,
    workspaceId,
    window.from,
    window.to,
    input.verbOverrideMaxEvents,
    input.verbOverrideBudget,
  );
  const events = digestEvents.events;
  const providers = digestProviders(context, events);
  const content = renderDigest({
    date: isoDate(window.date),
    generatedAt: input.generatedAt.toISOString(),
    covers: window.name,
    windowKey: window.windowKey,
    windowStart: window.from,
    windowEnd: window.to,
    timeZone: input.timeZone,
    providers,
    events,
    truncated: digestEvents.truncated,
    warnings: digestWarnings(digestEvents.truncated, events),
  });
  const revision = context.nextId("rev");
  const contentRef = context.contentRef(workspaceId, path, revision);
  const now = input.generatedAt.toISOString();
  if (
    previous?.revision &&
    revisionOrdinal(previous.revision) >= revisionOrdinal(revision)
  ) {
    return;
  }

  if (context.flushStorage) {
    await context.flushStorage();
  }

  await context.putObject(
    contentRef,
    content,
    "utf-8",
    DIGEST_CONTENT_TYPE,
    workspaceId,
    path,
    revision,
  );

  const contentHash = await hashContent(content, "utf-8");
  context.sqlExec(
    `
      INSERT INTO files (
        path, revision, content_type, content_ref, size, encoding, updated_at,
        semantics_json, provider, provider_object_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        revision = excluded.revision,
        content_type = excluded.content_type,
        content_ref = excluded.content_ref,
        size = excluded.size,
        encoding = excluded.encoding,
        updated_at = excluded.updated_at,
        semantics_json = excluded.semantics_json,
        provider = excluded.provider,
        provider_object_id = excluded.provider_object_id,
        content_hash = excluded.content_hash
      WHERE
        CAST(substr(excluded.revision, instr(excluded.revision, '_') + 1) AS INTEGER) >
        CAST(substr(files.revision, instr(files.revision, '_') + 1) AS INTEGER)
    `,
    path,
    revision,
    DIGEST_CONTENT_TYPE,
    contentRef,
    new TextEncoder().encode(content).byteLength,
    "utf-8",
    now,
    "{}",
    DIGEST_PROVIDER,
    "",
    contentHash,
  );
  const current = context.getFileRow(path);
  if (current?.revision !== revision || current?.contentRef !== contentRef) {
    await tryDeleteContent(context, contentRef);
    return;
  }

  const event = {
    eventId: context.nextId("evt"),
    type: previous ? "file.updated" : "file.created",
    path,
    revision,
    origin: "system",
    provider: DIGEST_PROVIDER,
    correlationId: input.correlationId,
    timestamp: now,
  } satisfies Parameters<WorkspaceDigestContext["insertEvent"]>[0];
  context.insertEvent(event, { broadcast: false });

  if (context.flushStorage) {
    await context.flushStorage();
  }
  context.broadcastEvent?.(event);

  if (previous?.contentRef && previous.contentRef !== contentRef) {
    await tryDeleteContent(context, previous.contentRef);
  }
}

function shouldSkipImplicitDigestRefresh(
  window: DigestWindow,
  previous: {
    updatedAt?: string;
  } | null,
  generatedAt: Date,
): boolean {
  if (!previous) return false;
  if (window.closed) return true;
  if (!previous.updatedAt) return false;
  const previousTime = Date.parse(previous.updatedAt);
  if (!Number.isFinite(previousTime)) return false;
  return generatedAt.getTime() - previousTime < 30_000;
}

async function tryDeleteContent(
  context: Pick<WorkspaceDigestContext, "deleteContent">,
  contentRef: string,
): Promise<void> {
  try {
    await context.deleteContent?.(contentRef);
  } catch (err) {
    console.error("digest: deleteContent cleanup failed", err);
  }
}

function revisionOrdinal(revision: string): number {
  const value = Number(revision.slice(revision.lastIndexOf("_") + 1));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

async function readDigestEvents(
  context: WorkspaceDigestContext,
  workspaceId: string,
  from: string,
  to: string,
  verbOverrideMaxEvents: number,
  verbOverrideBudget: VerbOverrideBudget | null,
): Promise<DigestEventsResult> {
  const rows = context
    .allRows<Row>(
      `
        SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp
        FROM (
          SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp
          FROM events
          WHERE timestamp >= ? AND timestamp < ?
            AND path NOT LIKE '/digests/%'
            AND path NOT LIKE '/discovery/%'
            AND path NOT LIKE '/.skills/%'
            AND path NOT LIKE '%/.relayfile.acl'
            AND path != '/.relayfile.acl'
            AND path NOT LIKE '%/LAYOUT.md'
            AND path != '/LAYOUT.md'
            AND path NOT LIKE '%/_index.json'
            AND path NOT LIKE '%/by-assignee/%'
            AND path NOT LIKE '%/by-author/%'
            AND path NOT LIKE '%/by-calendar/%'
            AND path NOT LIKE '%/by-conversation/%'
            AND path NOT LIKE '%/by-creator/%'
            AND path NOT LIKE '%/by-database/%'
            AND path NOT LIKE '%/by-day/%'
            AND path NOT LIKE '%/by-edited/%'
            AND path NOT LIKE '%/by-id/%'
            AND path NOT LIKE '%/by-key/%'
            AND path NOT LIKE '%/by-label/%'
            AND path NOT LIKE '%/by-name/%'
            AND path NOT LIKE '%/by-organizer/%'
            AND path NOT LIKE '%/by-parent/%'
            AND path NOT LIKE '%/by-participant/%'
            AND path NOT LIKE '%/by-priority/%'
            AND path NOT LIKE '%/by-query/%'
            AND path NOT LIKE '%/by-ref/%'
            AND path NOT LIKE '%/by-role/%'
            AND path NOT LIKE '%/by-sender/%'
            AND path NOT LIKE '%/by-space/%'
            AND path NOT LIKE '%/by-state/%'
            AND path NOT LIKE '%/by-status/%'
            AND path NOT LIKE '%/by-thread/%'
            AND path NOT LIKE '%/by-title/%'
            AND path NOT LIKE '%/by-username/%'
            AND path NOT LIKE '%/by-uuid/%'
            AND path != '/.relayfile-mount-state.json'
          ORDER BY timestamp DESC, CAST(SUBSTR(event_id, 5) AS INTEGER) DESC
          LIMIT ?
        )
        ORDER BY timestamp ASC, CAST(SUBSTR(event_id, 5) AS INTEGER) ASC
      `,
      from,
      to,
      DIGEST_EVENT_LIMIT + 1,
    )
    .map((row) => ({
      eventId: asString(row.event_id),
      type: asString(row.type),
      path: normalizePath(asString(row.path)),
      revision: asString(row.revision),
      origin: asString(row.origin),
      provider: asString(row.provider),
      correlationId: asString(row.correlation_id),
      timestamp: asString(row.timestamp),
    }))
    // Defense in depth: even if the SQL filter above misses a path (test
    // harnesses, future schema drift, or SQL LIKE pattern edge cases), the
    // centralized JS predicate guarantees internal paths never reach the
    // digest budget. Applied BEFORE the truncation/cap check so real activity
    // is what counts against the 2,000-event budget.
    .filter((row) => !isInternalDigestPath(row.path));

  const truncated = rows.length > DIGEST_EVENT_LIMIT;
  const selectedRows = truncated ? rows.slice(1) : rows;

  if (!context.loadContent) {
    return {
      events: selectedRows,
      truncated,
      warnings: digestWarnings(truncated, selectedRows),
    };
  }

  // Bound verb-override content reads to the most recent N create/update events
  // (cloud#1251): each readEventVerbOverride costs up to 2 R2 reads, so the full
  // window would fan out thousands of reads in a single alarm and trip the
  // Worker CPU/in-flight-subrequest limits. Older events keep the default verb.
  const overrideEligible = selectRecentVerbOverrideEligible(
    selectedRows,
    verbOverrideMaxEvents,
  );
  const eligibleRowsNewestFirst = selectedRows
    .filter((event) => overrideEligible.has(event.eventId))
    .reverse();
  const overrides = new Map<string, string>();
  await mapWithConcurrency(
    eligibleRowsNewestFirst,
    DIGEST_CONTENT_LOAD_CONCURRENCY,
    async (event) => {
      const verbOverride = await readEventVerbOverride(
        context,
        workspaceId,
        event,
        verbOverrideBudget,
      );
      if (verbOverride) {
        overrides.set(event.eventId, verbOverride);
      }
    },
  );
  const events = selectedRows.map((event) => {
    const verbOverride = overrides.get(event.eventId);
    return verbOverride ? { ...event, verbOverride } : event;
  });
  return { events, truncated, warnings: digestWarnings(truncated, events) };
}

// selectedRows is ascending (oldest first), so walk from the most recent: the
// freshest create/update events keep their precise content-derived verb ("was
// closed"/"merged") while older ones degrade to the default verb (less precise,
// never wrong). Bounds verb-override R2 reads to <= 2 * limit per refresh
// (cloud#1251).
function selectRecentVerbOverrideEligible(
  rows: readonly DigestEventRow[],
  limit: number,
): Set<string> {
  const eligible = new Set<string>();
  if (limit <= 0) {
    return eligible;
  }
  for (let i = rows.length - 1; i >= 0 && eligible.size < limit; i -= 1) {
    const row = rows[i];
    if (row && (row.type === "file.created" || row.type === "file.updated")) {
      eligible.add(row.eventId);
    }
  }
  return eligible;
}

function digestProviders(
  context: WorkspaceDigestContext,
  events: readonly DigestEventRow[],
): string[] {
  const providers = new Set<string>();
  for (const event of events) {
    if (event.provider) providers.add(event.provider);
  }
  for (const row of context.allRows<Row>(
    `
      SELECT DISTINCT provider
      FROM files
      WHERE provider != '' AND path NOT LIKE '/digests/%'
      ORDER BY provider ASC
      LIMIT 64
    `,
  )) {
    const provider = asString(row.provider);
    if (provider) providers.add(provider);
  }
  return [...providers].sort();
}

function digestWarnings(
  truncated: boolean,
  events: readonly DigestEventRow[],
): string[] {
  const warnings = [];
  if (truncated) warnings.push("digest_event_limit_exceeded");
  if (events.some((event) => event.type === "sync.error")) {
    warnings.push("provider_partial_failure");
  }
  return warnings;
}

function renderDigest(input: {
  date: string;
  generatedAt: string;
  covers: string;
  windowKey: string;
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  providers: readonly string[];
  events: readonly DigestEventRow[];
  truncated: boolean;
  warnings: readonly string[];
}): string {
  const lines = [
    "---",
    `date: ${input.date}`,
    `generated_at: ${input.generatedAt}`,
    `covers: ${input.covers}`,
    `window_key: ${input.windowKey}`,
    `window_start: ${input.windowStart}`,
    `window_end: ${input.windowEnd}`,
    `timezone: ${input.timeZone}`,
    `providers: [${input.providers.join(", ")}]`,
    `events: ${input.events.length}`,
    `truncated: ${input.truncated ? "true" : "false"}`,
    `warnings: [${input.warnings.join(", ")}]`,
    "---",
    "",
    `# Activity summary for ${input.date}`,
  ];

  if (input.providers.length === 0) {
    lines.push("", "_no activity_");
    return `${lines.join("\n")}\n`;
  }

  for (const provider of input.providers) {
    lines.push("", `## ${provider}`, "");
    const providerEvents = input.events.filter(
      (event) => event.provider === provider,
    );
    if (providerEvents.length === 0) {
      lines.push("_no activity_");
      continue;
    }
    const renderableEvents = providerEvents.filter(shouldRenderDigestEvent);
    if (renderableEvents.length === 0) {
      lines.push("_no activity_");
      continue;
    }
    for (const event of renderableEvents) {
      lines.push(
        `- ${eventIdentifier(event.path)} ${eventVerb(event)} - [${event.path}]`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function shouldRenderDigestEvent(event: DigestEventRow): boolean {
  if (event.provider !== "gitlab") return true;
  return isCanonicalGitLabDigestPath(event.path);
}

function eventIdentifier(path: string): string {
  const gitLabIdentifier = gitLabEventIdentifier(path);
  if (gitLabIdentifier) return gitLabIdentifier;

  const segments = path.split("/").filter(Boolean);
  const last = segments.at(-1) ?? path;
  const segment =
    last === "meta.json" ||
    last === "metadata.json" ||
    last === "page.md" ||
    last === "content.md"
      ? (segments.at(-2) ?? last)
      : last;
  const withoutExt = segment.replace(/\.[^.]+$/u, "");
  const separator = withoutExt.indexOf("__");
  const id = separator > 0 ? withoutExt.slice(0, separator) : withoutExt;
  if (path.includes("/github/") && /^\d+$/u.test(id)) return `#${id}`;
  if (path.includes("/gitlab/") && path.includes("/merge_requests/"))
    return `MR !${id}`;
  if (path.includes("/gitlab/") && path.includes("/issues/"))
    return `issue #${id}`;
  return id || path;
}

const GITLAB_DIGEST_RESOURCE_SEGMENTS = new Set([
  "commits",
  "deployments",
  "files",
  "issues",
  "jobs",
  "merge_requests",
  "pipelines",
  "snippets",
  "tags",
]);

const GITLAB_DIGEST_ALIAS_RESOURCE_SEGMENTS = new Set([
  "commits",
  "deployments",
  "issues",
  "merge_requests",
  "pipelines",
  "tags",
]);

function isCanonicalGitLabDigestPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? "";
  return (
    leaf !== "LAYOUT.md" &&
    leaf !== "_index.json" &&
    !isGitLabProjectByIdAliasPath(segments) &&
    !hasGitLabDigestAliasDirectory(segments) &&
    !isGitLabLegacyTagCleanupPath(segments) &&
    !isGitLabFullRefTagCleanupPath(segments) &&
    !isGitLabLegacyFlatTagCleanupPath(segments)
  );
}

function gitLabEventIdentifier(path: string): string | null {
  if (!path.includes("/gitlab/")) return null;
  const segments = path.split("/").filter(Boolean);
  const resourceIndex = gitLabDigestResourceSegmentIndex(segments);
  if (resourceIndex < 0) return null;
  const resource = segments[resourceIndex];
  const terminal = segments.at(-1);
  const segment =
    terminal === "meta.json" || terminal === "metadata.json"
      ? (segments.at(-2) ?? path)
      : (terminal ?? path);
  const basename = segment.replace(/\.[^.]+$/u, "");
  const id = gitLabDigestRecordId(resource, basename);

  if (resource === "merge_requests") return `MR !${id}`;
  if (resource === "issues") return `issue #${id}`;
  if (resource === "pipelines") return `pipeline #${id}`;
  if (resource === "jobs") return `job #${id}`;
  if (resource === "commits") return `commit ${id.slice(0, 12)}`;
  if (resource === "deployments") return `deployment #${id}`;
  if (resource === "tags") return `tag ${id}`;
  if (resource === "files") return `file ${id}`;
  if (resource === "snippets") return `snippet ${id}`;
  return null;
}

function gitLabDigestResourceSegmentIndex(segments: readonly string[]): number {
  for (let index = segments.length - 2; index >= 2; index -= 1) {
    const segment = segments[index];
    if (segment && GITLAB_DIGEST_RESOURCE_SEGMENTS.has(segment)) {
      return index;
    }
  }
  return -1;
}

function hasGitLabDigestAliasDirectory(segments: readonly string[]): boolean {
  if (segments[0] !== "gitlab" || segments[1] !== "projects") return false;

  for (let index = 2; index < segments.length - 1; index += 1) {
    if (isGitLabDigestAliasAt(segments, index)) return true;
  }
  return false;
}

function isGitLabDigestAliasAt(
  segments: readonly string[],
  resourceIndex: number,
): boolean {
  const resource = segments[resourceIndex];
  const alias = segments[resourceIndex + 1];
  if (
    !resource ||
    !alias ||
    !GITLAB_DIGEST_ALIAS_RESOURCE_SEGMENTS.has(resource)
  ) {
    return false;
  }

  if (
    alias === "by-state" ||
    alias === "by-assignee" ||
    alias === "by-creator" ||
    alias === "by-priority" ||
    alias === "by-status"
  ) {
    return segments.length === resourceIndex + 4;
  }

  if (alias === "by-id" || alias === "by-title" || alias === "by-ref") {
    return segments.length === resourceIndex + 3;
  }

  return false;
}

function isGitLabProjectByIdAliasPath(segments: readonly string[]): boolean {
  return (
    segments[0] === "gitlab" &&
    segments[1] === "projects" &&
    segments[2] === "by-id" &&
    segments.length === 4
  );
}

function isGitLabLegacyTagCleanupPath(segments: readonly string[]): boolean {
  if (segments[0] !== "gitlab" || segments[1] !== "projects") return false;
  const resourceIndex = gitLabDigestResourceSegmentIndex(segments);
  return (
    segments[resourceIndex] === "tags" && segments.length > resourceIndex + 2
  );
}

function isGitLabFullRefTagCleanupPath(segments: readonly string[]): boolean {
  if (segments[0] !== "gitlab" || segments[1] !== "projects") return false;
  const resourceIndex = gitLabDigestResourceSegmentIndex(segments);
  if (
    segments[resourceIndex] !== "tags" ||
    segments.length !== resourceIndex + 2
  ) {
    return false;
  }
  const basename = (segments.at(-1) ?? "").replace(/\.[^.]+$/u, "");
  return gitLabDigestRecordId("tags", basename).startsWith("refs/tags/");
}

function isGitLabLegacyFlatTagCleanupPath(
  segments: readonly string[],
): boolean {
  if (segments[0] !== "gitlab" || segments[1] !== "projects") return false;
  const resourceIndex = gitLabDigestResourceSegmentIndex(segments);
  if (
    segments[resourceIndex] !== "tags" ||
    segments.length !== resourceIndex + 2
  ) {
    return false;
  }
  const leaf = segments.at(-1) ?? "";
  const basename = leaf.replace(/\.[^.]+$/u, "");
  if (!basename.includes("__")) return false;
  const tagId = gitLabDigestRecordId("tags", basename);
  return leaf !== gitLabDigestFlatRecordFilename(tagId, tagId);
}

function gitLabDigestRecordId(
  resource: string | undefined,
  basename: string,
): string {
  const separatorIndex = basename.indexOf("__");
  if (separatorIndex <= 0) return basename;

  if (resource === "files") {
    return basename;
  }
  if (resource === "deployments" || resource === "tags") {
    return decodeGitLabDigestId(basename.slice(separatorIndex + 2));
  }
  return basename.slice(0, separatorIndex);
}

function gitLabDigestFlatRecordFilename(
  objectId: string,
  title?: string | null,
): string {
  const id = objectId.trim().replace(/\.json$/u, "");
  const slug = title
    ? slugifyGitLabDigestAlias(title)
    : slugifyGitLabDigestAlias(id);
  if (!slug || slug === "untitled" || slug === id) {
    return `${encodeURIComponent(id)}.json`;
  }
  return `${encodeURIComponent(slug)}__${encodeURIComponent(id)}.json`;
}

function slugifyGitLabDigestAlias(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "untitled"
  );
}

function decodeGitLabDigestId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function eventVerb(event: DigestEventRow): string {
  if (event.verbOverride) return event.verbOverride;

  switch (event.type) {
    case "file.created":
      return "was created";
    case "file.deleted":
      return "was deleted";
    case "sync.error":
      return "had a sync error";
    case "sync.ignored":
      return "was ignored";
    case "sync.suppressed":
      return "was suppressed";
    case "sync.stale":
      return "was stale";
    default:
      return "was updated";
  }
}

async function readEventVerbOverride(
  context: WorkspaceDigestContext,
  workspaceId: string,
  event: DigestEventRow,
  budget: VerbOverrideBudget | null,
): Promise<string | undefined> {
  if (event.type !== "file.created" && event.type !== "file.updated") {
    return undefined;
  }
  const revisionRef = context.contentRef(
    workspaceId,
    event.path,
    event.revision,
  );
  const revisionContent = await readContentRef(context, revisionRef, budget);
  const revisionVerb = revisionContent
    ? terminalStateVerbFromContent(event.path, revisionContent)
    : null;
  if (revisionVerb) return revisionVerb;

  const current = context.getFileRow(event.path);
  const currentRef = current?.contentRef;
  if (
    !currentRef ||
    currentRef === revisionRef ||
    current.updatedAt !== event.timestamp
  ) {
    return undefined;
  }
  const currentContent = await readContentRef(context, currentRef, budget);
  return currentContent
    ? (terminalStateVerbFromContent(event.path, currentContent) ?? undefined)
    : undefined;
}

function terminalStateVerbFromContent(
  path: string,
  content: Record<string, unknown>,
): string | null {
  const payload = readRecord(content, "payload") ?? content;
  const webhook = readRecord(content, "_webhook");
  const payloadWebhook = readRecord(payload, "_webhook");
  const action = [
    readLowerString(webhook, "action"),
    readLowerString(webhook, "eventType"),
    readLowerString(payloadWebhook, "action"),
    readLowerString(payloadWebhook, "eventType"),
    readLowerString(content, "action"),
    readLowerString(content, "eventType"),
    readLowerString(content, "type"),
  ].join(".");

  if (hasActionVerb(action, "unarchive|unarchived")) {
    return "was unarchived";
  }
  if (hasActionVerb(action, "restore|restored")) {
    return "was restored";
  }
  if (hasActionVerb(action, "archive|archived")) {
    return "was archived";
  }
  if (hasActionVerb(action, "success|succeeded")) {
    return "succeeded";
  }
  if (hasActionVerb(action, "fail|failed")) {
    return "failed";
  }
  if (hasActionVerb(action, "skip|skipped")) {
    return "was skipped";
  }
  if (hasActionVerb(action, "cancel|canceled|cancelled")) {
    return "was canceled";
  }

  const state =
    readLowerString(payload, "state") ||
    readLowerString(content, "state") ||
    readLowerPath(payload, ["state", "type"]) ||
    readLowerPath(payload, ["state", "name"]);
  const status =
    readLowerString(payload, "status") ||
    readLowerString(content, "status") ||
    readLowerPath(payload, ["fields", "status", "name"]);
  const stateName =
    readLowerString(payload, "state_name") ||
    readLowerString(content, "state_name") ||
    readLowerPath(payload, ["state", "name"]);
  const merged =
    payload.merged === true || content.merged === true || state === "merged";

  if (merged && isPullOrMergeRequestPath(path)) {
    return "was merged";
  }
  if (state === "closed" || status === "closed") {
    return "was closed";
  }
  if (state === "done" || stateName === "done" || status === "done") {
    return "was completed";
  }
  if (
    state === "canceled" ||
    stateName === "canceled" ||
    status === "canceled" ||
    status === "cancelled"
  ) {
    return "was canceled";
  }
  if (status === "success" || status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "skipped") {
    return "was skipped";
  }
  if (
    state === "archived" ||
    status === "archived" ||
    state === "trashed" ||
    status === "trashed" ||
    content.archived === true ||
    content.in_trash === true ||
    payload.archived === true ||
    payload.in_trash === true ||
    payload.is_archived === true
  ) {
    return "was archived";
  }
  return null;
}

function isPullOrMergeRequestPath(path: string): boolean {
  return path.includes("/pulls/") || path.includes("/merge_requests/");
}

function readLowerString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string {
  if (!record) return "";
  const value = record[key];
  return typeof value === "string" ? value.toLowerCase() : "";
}

function readLowerPath(
  record: Record<string, unknown>,
  path: readonly string[],
): string {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) return "";
    current = current[segment];
  }
  return typeof current === "string" ? current.toLowerCase() : "";
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function hasActionVerb(action: string, verbs: string): boolean {
  return new RegExp(`(^|[^a-z0-9])(${verbs})([^a-z0-9]|$)`, "u").test(action);
}

function readContentRef(
  context: WorkspaceDigestContext,
  contentRef: string,
  budget: VerbOverrideBudget | null,
): Promise<Record<string, unknown> | undefined> {
  return (async () => {
    const reservation = reserveVerbOverrideBytes(budget);
    if (!reservation.admitted) {
      return undefined;
    }
    let loadedBytes = 0;
    try {
      const content = await context.loadContent?.(
        contentRef,
        "utf-8",
        reservation.maxReadBytes,
      );
      if (!content) return undefined;
      loadedBytes = DIGEST_TEXT_ENCODER.encode(content).byteLength;
      const parsed = JSON.parse(content) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    } finally {
      releaseVerbOverrideBytes(reservation, loadedBytes);
    }
  })();
}

function createVerbOverrideBudget(maxBytes: number): VerbOverrideBudget | null {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    return {
      maxBytes: DIGEST_TOTAL_VERB_OVERRIDE_BUDGET_BYTES,
      loadedBytes: 0,
      reservedBytes: 0,
    };
  }
  if (maxBytes === 0) {
    return null;
  }
  return {
    maxBytes: Math.floor(maxBytes),
    loadedBytes: 0,
    reservedBytes: 0,
  };
}

function reserveVerbOverrideBytes(budget: VerbOverrideBudget | null):
  | { admitted: false }
  | {
      admitted: true;
      budget: VerbOverrideBudget | null;
      reservedBytes: number;
      maxReadBytes: number;
    } {
  if (!budget) {
    return {
      admitted: true,
      budget: null,
      reservedBytes: 0,
      maxReadBytes: DIGEST_EVENT_CONTENT_MAX_READ_BYTES,
    };
  }
  const remaining = budget.maxBytes - budget.loadedBytes - budget.reservedBytes;
  if (remaining <= 0) {
    return { admitted: false };
  }
  const reservedBytes = Math.min(
    remaining,
    DIGEST_EVENT_CONTENT_MAX_READ_BYTES,
  );
  budget.reservedBytes += reservedBytes;
  return {
    admitted: true,
    budget,
    reservedBytes,
    maxReadBytes: reservedBytes,
  };
}

function releaseVerbOverrideBytes(
  reservation:
    | { admitted: false }
    | {
        admitted: true;
        budget: VerbOverrideBudget | null;
        reservedBytes: number;
      },
  loadedBytes: number,
): void {
  if (!reservation.admitted) {
    return;
  }
  if (!reservation.budget) {
    return;
  }
  reservation.budget.reservedBytes = Math.max(
    0,
    reservation.budget.reservedBytes - reservation.reservedBytes,
  );
  reservation.budget.loadedBytes += Math.max(0, loadedBytes);
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        results[index] = await mapper(values[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function defaultDigestWindows(
  generatedAt: Date,
  timeZone: string,
): DigestWindowRequest[] {
  const today = localDateForInstant(generatedAt, timeZone);
  const yesterday = addLocalDays(today, -1);
  return ["today", "yesterday", isoDate(yesterday), "this-week", "last-week"];
}

function resolveWindow(
  name: DigestWindowRequest,
  generatedAt: Date,
  timeZone: string,
): DigestWindow | null {
  const today = localDateForInstant(generatedAt, timeZone);
  if (name === "today") {
    return dailyWindow(name, today, timeZone, false);
  }
  if (name === "yesterday") {
    return dailyWindow(name, addLocalDays(today, -1), timeZone, true);
  }
  if (name === "this-week") {
    return weeklyWindow(name, startOfIsoWeek(today), timeZone, false);
  }
  if (name === "last-week") {
    return weeklyWindow(
      name,
      addLocalDays(startOfIsoWeek(today), -7),
      timeZone,
      true,
    );
  }
  if (isIsoDateString(name)) {
    const date = parseIsoDate(name);
    return dailyWindow(
      name,
      date,
      timeZone,
      compareLocalDates(date, today) < 0,
    );
  }
  return null;
}

function dailyWindow(
  name: string,
  date: LocalDate,
  timeZone: string,
  closed: boolean,
): DigestWindow {
  const from = startOfLocalDate(date, timeZone);
  const to = startOfLocalDate(addLocalDays(date, 1), timeZone);
  const dateString = isoDate(date);
  return {
    name,
    path: `/digests/${name}.md`,
    date,
    from: from.toISOString(),
    to: to.toISOString(),
    windowKey: `date:${dateString}`,
    closed,
  };
}

function weeklyWindow(
  name: string,
  start: LocalDate,
  timeZone: string,
  closed: boolean,
): DigestWindow {
  const from = startOfLocalDate(start, timeZone);
  const to = startOfLocalDate(addLocalDays(start, 7), timeZone);
  return {
    name,
    path: `/digests/${name}.md`,
    date: start,
    from: from.toISOString(),
    to: to.toISOString(),
    windowKey: `week:${isoWeekKey(start)}`,
    closed,
  };
}

function normalizeTimeZone(timeZone: string | undefined): string {
  const candidate = timeZone?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(),
    );
    return candidate;
  } catch {
    return "UTC";
  }
}

function localDateForInstant(date: Date, timeZone: string): LocalDate {
  const parts = zonedParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function startOfLocalDate(date: LocalDate, timeZone: string): Date {
  return zonedDateTimeToUtc(date.year, date.month, date.day, 0, 0, 0, timeZone);
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wallTime = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = wallTime;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMs(new Date(utc), timeZone);
    utc = wallTime - offset;
  }
  return new Date(utc);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - date.getTime()
  );
}

function zonedParts(
  date: Date,
  timeZone: string,
): LocalDate & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function startOfIsoWeek(date: LocalDate): LocalDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const day = utc.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return addLocalDays(date, -daysSinceMonday);
}

function isoWeekKey(monday: LocalDate): string {
  const thursday = addLocalDays(monday, 3);
  const firstThursday = addLocalDays(
    startOfIsoWeek({ year: thursday.year, month: 1, day: 4 }),
    3,
  );
  const diffDays = Math.round(
    (Date.UTC(thursday.year, thursday.month - 1, thursday.day) -
      Date.UTC(
        firstThursday.year,
        firstThursday.month - 1,
        firstThursday.day,
      )) /
      86_400_000,
  );
  return `${thursday.year}-W${String(Math.floor(diffDays / 7) + 1).padStart(
    2,
    "0",
  )}`;
}

function compareLocalDates(left: LocalDate, right: LocalDate): number {
  return (
    Date.UTC(left.year, left.month - 1, left.day) -
    Date.UTC(right.year, right.month - 1, right.day)
  );
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function parseIsoDate(value: string): LocalDate {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return { year: year ?? 0, month: month ?? 1, day: day ?? 1 };
}

function isoDate(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(
    date.day,
  ).padStart(2, "0")}`;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return `/${trimmed.replace(/^\/+/u, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
