import type { FileReadResponse } from "@relayfile/sdk";
import type { WorkspaceFile } from "../types.js";

/**
 * A file served by the relayfile DO at runtime without being stored in the
 * workspace database. Injected into directory listings and reads transparently.
 * Paths must be under `/.skills/` and must be sorted ascending for the
 * listing insertion logic in adapter.ts / fs.ts to work correctly.
 */
export interface RuntimeFile {
  readonly path: string;
  readonly contentRef: string;
  readonly revision: string;
  readonly updatedAt: string;
  readonly content: string;
}

// ── activity summary ──────────────────────────────────────────────────────────

const ACTIVITY_SUMMARY: RuntimeFile = {
  path: "/.skills/activity-summary.md",
  contentRef: "runtime:activity-summary",
  revision: "runtime_activity_summary_v1",
  updatedAt: "2026-05-18T00:00:00.000Z",
  content: `# Activity Summary

Use the hosted digest files under /digests/ to summarize workspace activity.

Available windows:
- /digests/today.md
- /digests/yesterday.md
- /digests/this-week.md
- /digests/last-week.md
- /digests/YYYY-MM-DD.md

Digest frontmatter includes window_key, window_start, window_end, timezone, events, truncated, and warnings. If warnings includes digest_event_limit_exceeded, the digest contains the newest bounded event page for that window.
`,
};

// ── workspace-layout skill ────────────────────────────────────────────────────

const WORKSPACE_LAYOUT: RuntimeFile = {
  path: "/.skills/workspace-layout/SKILL.md",
  contentRef: "runtime:workspace-layout",
  revision: "runtime_workspace_layout_v1",
  updatedAt: "2026-06-11T00:00:00.000Z",
  content: `---
name: workspace-layout
description: Use when an agent is exploring a relayfile mount for the first time or trying to locate a specific resource (Notion page, Linear issue, Slack channel, GitHub PR). Tells the agent to start with \`<mount>/LAYOUT.md\` and \`<provider>/LAYOUT.md\` rather than guessing paths from memory, and to use the \`by-title/\`, \`by-id/\`, \`by-name/\`, \`by-edited/<date>/\`, \`by-state/\` alias subtrees instead of recursively grepping. Filename convention is \`<identifier>__<uuid>\` (ticket number / slug first so listings are scannable). NOT for activity-summary questions, which should use the \`activity-summary\` skill instead.
---

# Workspace Layout — Start With LAYOUT.md

## Overview

A relayfile mount is **self-describing**. Every workspace has a \`LAYOUT.md\` at its root, and every provider has a \`LAYOUT.md\` at its provider root, that together describe the directory shape, the filename conventions, and the indexes available for fast lookup. Read these first. Do not guess paths from memory — provider layouts can be customized per workspace and the indexes available may differ.

## When to use this skill

- You just connected to a relayfile mount and have no prior context about its shape.
- You need to find a specific resource (a Notion page by title, a Linear issue by number, a Slack channel by name).
- You're tempted to run \`find\` or \`grep -r\` across the mount — almost always there is an index that does it cheaper.
- You see paths in someone else's code or in a digest and want to understand them.

If the user is asking an activity-summary question ("what did I work on yesterday"), use the \`activity-summary\` skill instead. This skill is for resource lookup, not time-windowed queries.

## Step 1: Read the root layout

\`\`\`bash
$ cat $MOUNT/LAYOUT.md
\`\`\`

The root \`LAYOUT.md\` lists the connected providers, the digests directory, the skills directory, and any cross-provider conventions in effect for this workspace.

## Step 2: Read the provider layout

\`\`\`bash
$ cat $MOUNT/linear/LAYOUT.md
\`\`\`

The per-provider layout covers:

- Top-level directories under the provider root (e.g. \`issues/\`, \`projects/\`, \`cycles/\`)
- Filename conventions in use (\`<identifier>__<uuid>.json\`, plain UUID, slug-based, …)
- Which \`by-*\` alias indexes are populated
- Writeback directories and their schemas (see the \`writeback-as-files\` skill)
- Whether content is paginated and how

## Step 3: Use alias indexes, not recursive search

Canonical records are keyed by UUID for stability. Alias indexes live under \`by-*/\` and point back to the canonical files. Reach for an index that matches your query shape:

\`\`\`bash
# Find a Notion page by title
$ ls $MOUNT/notion/pages/by-title/ | grep -i "onboarding"
onboarding-runbook__c24642bb.json
$ jq -r '.id' $MOUNT/notion/pages/by-title/onboarding-runbook__c24642bb.json

# Find a Linear issue by ticket number (identifier is part of the canonical
# filename, so a direct ls is sufficient — no by-id/ needed)
$ ls $MOUNT/linear/issues/ | grep "^AGE-16"

# Find what was edited yesterday in Notion
$ ls $MOUNT/notion/pages/by-edited/2026-05-12/

# Find all Linear issues currently In Progress
$ ls $MOUNT/linear/issues/by-state/in-progress/

# Find a Slack channel by name
$ ls $MOUNT/slack/channels/by-name/ | grep "gtm"
\`\`\`

Indexes are symlinks (or directory listings on filesystems without symlink support) — they don't duplicate the underlying content, so they stay cheap to enumerate even on workspaces with thousands of records.

## Filename convention

Canonical files use **\`<identifier>__<uuid>.<ext>\`** — identifier first so directory listings are immediately scannable:

\`\`\`bash
$ ls $MOUNT/linear/issues/
AGE-9__<uuid>.json
AGE-10__<uuid>.json
AGE-16__<uuid>.json
\`\`\`

The \`__\` (double underscore) separator is reserved — provider data must not produce it in the identifier portion. If you see a filename without \`__\` it's an alias-index symlink or a metadata file, not a canonical record.

## Common patterns

### "Where does X live?"

\`\`\`bash
cat $MOUNT/LAYOUT.md              # provider list and cross-cutting layout
cat $MOUNT/<provider>/LAYOUT.md   # provider-specific shape
ls   $MOUNT/<provider>/           # top-level resource directories
ls   $MOUNT/<provider>/<resource>/by-*/   # available indexes
\`\`\`

Three to four \`cat\`/\`ls\` calls and you have the full map.

### "I have a UUID, what is it?"

The UUID is in the filename. \`ls\` and \`grep\` find it without needing to know which directory:

\`\`\`bash
$ find $MOUNT -name "*<uuid>*" -type f
$MOUNT/linear/issues/AGE-16__<uuid>.json
\`\`\`

Use \`find\` here because record UUIDs are globally unique — the result is one file.

### "I have a slug or title, what is it?"

Use \`by-title/\` or \`by-name/\` rather than \`find\`. The index is sorted and bounded; \`find\` walks the full tree.

## What NOT to do

- **Don't \`grep -r\` over the mount** for a title or name. There's an index. Use it.
- **Don't hardcode paths from a different workspace's LAYOUT.md.** Workspaces can customize which adapters and indexes are mounted.
- **Don't ignore provider \`LAYOUT.md\`.** If you wrote a Notion-specific path from memory and it doesn't exist, the provider's \`LAYOUT.md\` will tell you the actual shape in one read.
`,
};

// ── writeback-as-files skill ──────────────────────────────────────────────────

const WRITEBACK_AS_FILES: RuntimeFile = {
  path: "/.skills/writeback-as-files/SKILL.md",
  contentRef: "runtime:writeback-as-files",
  revision: "runtime_writeback_as_files_v1",
  updatedAt: "2026-06-11T00:00:00.000Z",
  content: `---
name: writeback-as-files
description: Use when an agent needs to write back to a provider through a relayfile mount (Linear comments, GitHub issues, Slack messages, Notion pages, etc.). Covers the file-creation writeback contract (drop JSON at the canonical path → provider mutation), discovering paths and schemas via .schema.json siblings, idempotency keys, writeback status with relayfile writeback list and relayfile status, and recovering from dead-lettered writes under .relay/dead-letter/. NOT for read operations or for direct API calls — relayfile mediates the writeback so you can ignore provider auth, retries, and rate limits.
---

# Writebacks Are Files

## Overview

In a relayfile mount, the agent does not call a provider API to mutate state. It **writes a file**. The mount daemon picks up the change, validates the payload against the canonical schema, signs and delivers the request to the provider, and records the result. Auth, retries, idempotency, dead-lettering, and the audit trail are handled on the other side.

## When to use this skill

- The user asks the agent to take an action against a provider (comment, message, create, update, close, react, …).
- You see a writable path under \`<mount>/<provider>/…\` and want to know what shape the file should be.
- A previous write didn't seem to take effect and you need to find out why.
- You're about to call a provider SDK directly — stop and check if relayfile already exposes a writeback for that mutation.

## The contract in one sentence

> Drop a JSON file at the canonical writeback path; the provider receives the corresponding mutation within ~30 seconds.

## Find the canonical path

Writeback directories are discoverable in the mount. They sit next to the read-side data and carry a sibling \`.schema.json\` describing the expected payload.

\`\`\`bash
# What can I do under a Linear issue?
$ ls $MOUNT/linear/issues/AGE-16__87389837-62b1-4e1a-a237-59218bab2974/
content.md
comments/                # writeback dir — drop JSON files here
comments/.schema.json    # schema for individual comment writebacks
state-transitions/       # writeback dir — drop JSON to move issue state
state-transitions/.schema.json
\`\`\`

\`\`\`bash
# What's the schema for a Linear comment?
$ cat $MOUNT/linear/issues/AGE-16__.../comments/.schema.json
{
  "type": "object",
  "required": ["body"],
  "properties": {
    "body": { "type": "string", "minLength": 1, "maxLength": 65535 },
    "asUserId": { "type": "string" }
  }
}
\`\`\`

Schemas are the source of truth. Read them before guessing payload shape.

## Examples

### Post a Linear comment

\`\`\`bash
cat > $MOUNT/linear/issues/AGE-16__.../comments/wb-$(date +%s).json <<'EOF'
{
  "body": "Picking this up — design clarified the blocker."
}
EOF
\`\`\`

### Open a GitHub issue

\`\`\`bash
cat > $MOUNT/github/repos/AgentWorkforce/relay/issues/wb-$(date +%s).json <<'EOF'
{
  "title": "Race condition in writeback retry loop",
  "body": "Repro: …\\n\\nExpected: …\\n\\nActual: …",
  "labels": ["bug", "writeback"]
}
EOF
\`\`\`

### Send a Slack message

\`\`\`bash
cat > "$MOUNT/slack/channels/<channel-id>__<channel-name>/messages/wb-$(date +%s).json" <<'EOF'
{
  "text": "Customer signed — moving them to the activation channel."
}
EOF
\`\`\`

### Update a Notion page body

\`\`\`bash
# Notion content.md is a *write-through* file — overwriting it queues an update.
echo "# Onboarding\\n\\nUpdated …" > $MOUNT/notion/pages/<id>/content.md
\`\`\`

## Filename conventions

- **Use a unique suffix** (timestamp + short random) so retries don't collide. The mount daemon also derives an idempotency key from the file path, so two writes to the same path inside the dedup window are coalesced.
- **\`wb-<timestamp>.json\`** is the conventional prefix for agent-authored writebacks. It makes them easy to spot in dead-letter forensics.
- Do **not** name files \`.tmp\` or use rsync-style \`.partial\` — the daemon picks up files atomically on rename close; partial-suffix files are ignored.

## Watching status

\`\`\`bash
# Pending writebacks (queued but not delivered yet)
relayfile writeback list --state pending

# Failed writebacks (dead-lettered after exhausting retries)
relayfile writeback list --state dead

# Quick health check
relayfile status
# workspace rw_xxxxxxxx (my-agent)   mode: poll   lag: 4s
# linear   ready    214 files    last event 2s ago
# pending writebacks: 0    dead-lettered: 0
\`\`\`

\`dead-lettered: 0\` is the field to watch. If it goes non-zero, your writes are not landing.

## Dead-letter recovery

Failed writebacks land in \`<mount>/.relay/dead-letter/\` with the original payload plus a \`.error.json\` sibling explaining the failure:

\`\`\`bash
$ ls $MOUNT/.relay/dead-letter/
wb-1715608327.json
wb-1715608327.error.json

$ cat $MOUNT/.relay/dead-letter/wb-1715608327.error.json
{
  "code": "schema_violation",
  "message": "body: must be at least 1 character",
  "attempts": 1,
  "lastAttemptAt": "2026-05-13T14:32:07Z"
}
\`\`\`

Typical causes:

- \`schema_violation\` — your payload didn't match \`.schema.json\`. Fix and re-drop.
- \`provider_4xx\` — provider rejected (auth scope, missing parent, etc.). The error body contains the provider's response.
- \`provider_5xx_exhausted\` — provider repeatedly failed after backoff. Usually transient; re-drop with a fresh filename.

To replay: read the original payload, fix what's wrong, write to a fresh path with a new suffix.

## What NOT to do

- **Don't call the provider SDK directly** from within the agent if a writeback path exists. You lose the retry, idempotency, dead-letter, and audit story.
- **Don't write to read-only paths.** The mount enforces read-only at the OS level on canonical record files (e.g. \`*.json\` payloads). If your write returns \`EACCES\`, find the writeback subdirectory instead.
- **Don't poll for completion in a tight loop.** Subscribe to the change stream for \`writeback.succeeded\` and \`writeback.failed\` events.
`,
};

// ── registry — sorted by path for binary-search insertion ────────────────────

/**
 * All runtime files served by the DO. Must remain sorted by `path` so the
 * interleaving logic in adapter.ts and fs.ts can advance through them in one
 * forward pass alongside the DB cursor.
 */
export const RUNTIME_FILES: readonly RuntimeFile[] = [
  ACTIVITY_SUMMARY,
  WORKSPACE_LAYOUT,
  WRITEBACK_AS_FILES,
].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// ── generic helpers ───────────────────────────────────────────────────────────

/** Return the runtime file at `path`, or null if it is a real DB file. */
export function getRuntimeFileByPath(path: string): RuntimeFile | null {
  return RUNTIME_FILES.find((f) => f.path === path) ?? null;
}

/**
 * Return all runtime files whose path is listed under `base`. Used for
 * directory listing and list-tree operations.
 * `base = "/"` returns all runtime files.
 */
export function getRuntimeFilesUnderBase(base = "/"): readonly RuntimeFile[] {
  if (base === "/" || base === "") return RUNTIME_FILES;
  const prefix = base.replace(/\/+$/u, "") + "/";
  return RUNTIME_FILES.filter(
    (f) => f.path === base || f.path.startsWith(prefix),
  );
}

/** Convert a RuntimeFile to the WorkspaceFile shape used by the listing APIs. */
export function runtimeWorkspaceFile(f: RuntimeFile): WorkspaceFile {
  return {
    path: f.path,
    revision: f.revision,
    contentType: "text/markdown; charset=utf-8",
    contentRef: f.contentRef,
    size: new TextEncoder().encode(f.content).byteLength,
    encoding: "utf-8",
    provider: "runtime",
    providerObjectId: f.contentRef.replace(/^runtime:/, ""),
    updatedAt: f.updatedAt,
    semanticsJson: "{}",
    contentHash: "",
  };
}

/** Convert a RuntimeFile to the FileReadResponse returned by the read APIs. */
export function runtimeReadResponse(f: RuntimeFile): FileReadResponse {
  return {
    path: f.path,
    revision: f.revision,
    contentType: "text/markdown; charset=utf-8",
    content: f.content,
    encoding: "utf-8",
    provider: "runtime",
    providerObjectId: f.contentRef.replace(/^runtime:/, ""),
    lastEditedAt: f.updatedAt,
    semantics: {},
  };
}

/** Resolve inline content for a contentRef that points at a RuntimeFile. */
export function runtimeContentForRef(contentRef: string): string | null {
  return RUNTIME_FILES.find((f) => f.contentRef === contentRef)?.content ?? null;
}

// ── backward-compat exports (existing call sites unchanged) ───────────────────

export const ACTIVITY_SUMMARY_PATH = ACTIVITY_SUMMARY.path;
export const ACTIVITY_SUMMARY_CONTENT = ACTIVITY_SUMMARY.content;
export const ACTIVITY_SUMMARY_CONTENT_REF = ACTIVITY_SUMMARY.contentRef;
export const ACTIVITY_SUMMARY_REVISION = ACTIVITY_SUMMARY.revision;
export const ACTIVITY_SUMMARY_UPDATED_AT = ACTIVITY_SUMMARY.updatedAt;

export function activitySummaryReadResponse(): FileReadResponse {
  return runtimeReadResponse(ACTIVITY_SUMMARY);
}

export function activitySummaryWorkspaceFile(): WorkspaceFile {
  return runtimeWorkspaceFile(ACTIVITY_SUMMARY);
}

export function virtualActivitySummaryFile(base = "/"): WorkspaceFile | null {
  if (!pathContainsActivitySummary(base)) return null;
  return activitySummaryWorkspaceFile();
}

export function pathContainsActivitySummary(base: string): boolean {
  if (base === "/" || base === "") return true;
  if (base === ACTIVITY_SUMMARY_PATH) return true;
  return ACTIVITY_SUMMARY_PATH.startsWith(`${base.replace(/\/+$/u, "")}/`);
}
