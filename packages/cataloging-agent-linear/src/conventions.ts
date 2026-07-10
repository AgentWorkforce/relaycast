import type { VfsConventionFragment } from "@cloud/cataloging-agent-core";
import { LINEAR_PATH_ROOT } from "@relayfile/adapter-linear/path-mapper";

import { BY_ID_SEGMENT, BY_NAME_SEGMENT, BY_STATE_SEGMENT, BY_TITLE_SEGMENT } from "./aliases.js";
import packageJson from "../package.json" with { type: "json" };

const PATH_SEGMENT_LIMIT_BYTES = 255;
const PLACEHOLDER_PATTERN = /^\{[^{}]+\}$/u;
const PATH_SEGMENT_ENCODER = new TextEncoder();

// TODO(#106): consolidate with the adapter's shared nameWithId helper once it is exported.
//
// Kept as a public utility for callers that need to build a `<slug>__<id>`
// segment for non-canonical paths.
export function nameWithId(name: string | null | undefined, id: string): string {
  const normalizedId = normalizeRequiredId(id);
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    return normalizedId;
  }

  const maxSlugBytes = PATH_SEGMENT_LIMIT_BYTES - byteLength(`__${normalizedId}`);
  if (maxSlugBytes <= 0) {
    return normalizedId;
  }

  const slug = trimTrailingSeparators(truncateToBytes(normalizedName, maxSlugBytes));
  return slug ? `${slug}__${normalizedId}` : normalizedId;
}

/**
 * Build a placeholder-bearing path pattern keyed off the adapter's
 * canonical `LINEAR_PATH_ROOT`.
 *
 * The adapter's `linearIssuePath` etc. URI-encode every segment, which is
 * correct for real IDs but wrong for the literal `{id}` placeholder. We
 * derive the root from the adapter and assemble the rest as a literal
 * template.
 *
 * `@relayfile/adapter-linear` writes Linear documents at
 * `/linear/<type>/<id>.json` when no human-readable segment is available, and
 * at `/linear/<type>/<slug>__<id>.json` for slug-prefixed issue/comment
 * records.
 */
function linearTypePath(type: string): string {
  return `${LINEAR_PATH_ROOT}/${type}/{id}.json`;
}

function linearSlugPrefixedTypePath(type: string): string {
  return `${LINEAR_PATH_ROOT}/${type}/{slug}__{id}.json`;
}

/**
 * Resolve the `@relayfile/adapter-linear` version this cataloging agent
 * was built against.
 *
 * Reads our own `package.json` (which we control and ship with our
 * source) rather than the adapter's package.json — the adapter's
 * `exports` map doesn't include `./package.json`, so importing it
 * directly is not portable across resolvers.
 */
function resolveAdapterVersion(): string {
  const declared = packageJson.dependencies?.["@relayfile/adapter-linear"];
  if (!declared) {
    throw new Error(
      "cataloging-agent-linear expected @relayfile/adapter-linear in its dependencies",
    );
  }
  return declared.replace(/^[\^~>=<]+/, "").trim();
}

const ADAPTER_VERSION = resolveAdapterVersion();

// TODO(#106): consolidate with adapter LAYOUT_MD once the adapter exports it.
export const LINEAR_LAYOUT_MD = `# Workspace layout for /linear

Use this mount root for Linear data written by cataloging syncs.

- \`issues/\` contains issue JSON documents.
- \`comments/\` contains comment JSON documents.
- Issue and comment files may use either \`<id>.json\` or \`<slug>__<id>.json\`; the latter is emitted when Linear supplies a human-readable identifier, title, or label for the record.
- Project, cycle, and team files use the bare \`<id>.json\` form.
- Each populated directory also includes a bare-array \`_index.json\` file for quick listing.
- Linear issue rows include \`id\`, \`title\`, \`updated\`, and usually \`identifier\` plus \`state\`.
- Other rows fall back to the shared \`id\`, \`title\`, \`updated\` shape.

Read the leaf JSON files for the full object payloads.
`;

/**
 * Build the Linear VFS convention fragment.
 *
 * Linear's path layout is flat — issues, comments, projects, etc. all
 * live directly under `/linear/<type>/<id>.json` rather than the
 * owner/repo nesting GitHub uses. `{id}` is the placeholder the
 * assistant substitutes when issuing tool calls.
 */
export function buildLinearConventionFragment(): VfsConventionFragment {
  return {
    provider: "linear",
    version: ADAPTER_VERSION,
    generatedAt: new Date().toISOString(),
    paths: [
      {
        pattern: linearTypePath("issues"),
        description: "Issue metadata (state: open|completed|cancelled|...)",
        objectType: "issue",
      },
      {
        pattern: linearSlugPrefixedTypePath("issues"),
        description:
          "Issue metadata keyed by adapter-emitted slug-prefixed segment; id remains the canonical suffix",
        objectType: "issue",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/issues/${BY_TITLE_SEGMENT}/{slug}.json`,
        description: "Issue alias keyed by slugified title; read JSON to recover canonical __id",
        objectType: "issue-alias-by-title",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/issues/${BY_ID_SEGMENT}/{id}.json`,
        description: "Issue alias keyed by canonical identifier for disambiguation",
        objectType: "issue-alias-by-id",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/issues/${BY_STATE_SEGMENT}/{state}/{id}.json`,
        description: "Issue alias grouped by normalized state.type for state-scoped browsing",
        objectType: "issue-by-state",
      },
      {
        pattern: linearTypePath("comments"),
        description: "Issue comment",
        objectType: "comment",
      },
      {
        pattern: linearSlugPrefixedTypePath("comments"),
        description:
          "Issue comment keyed by adapter-emitted slug-prefixed segment; id remains the canonical suffix",
        objectType: "comment",
      },
      {
        pattern: linearTypePath("projects"),
        description: "Project metadata",
        objectType: "project",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/projects/${BY_TITLE_SEGMENT}/{slug}.json`,
        description: "Project alias keyed by slugified title; read JSON to recover canonical __id",
        objectType: "project-alias-by-title",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/projects/${BY_ID_SEGMENT}/{id}.json`,
        description: "Project alias keyed by canonical identifier for disambiguation",
        objectType: "project-alias-by-id",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/projects/${BY_STATE_SEGMENT}/{state}/{id}.json`,
        description: "Project alias grouped by normalized state.type for state-scoped browsing",
        objectType: "project-by-state",
      },
      {
        pattern: linearTypePath("cycles"),
        description: "Cycle metadata",
        objectType: "cycle",
      },
      {
        pattern: linearTypePath("teams"),
        description: "Team metadata",
        objectType: "team",
      },
      {
        pattern: `${LINEAR_PATH_ROOT}/teams/${BY_NAME_SEGMENT}/{slug}.json`,
        description: "Team alias keyed by slugified name; read JSON to recover canonical __id",
        objectType: "team-alias-by-name",
      },
    ],
    typicalQueries: [
      {
        intent: "list open issues for an assignee",
        steps: [
          `workspace_list('${LINEAR_PATH_ROOT}/issues', depth=1)`,
          "for each returned <id>.json or <slug>__<id>.json file, workspace_read_json(path)",
          "filter where json.state.type !== 'completed' && json.state.type !== 'canceled'",
          "filter where json.assignee?.id === '{userId}' || json.assignee?.name === '{name}'",
          "sort by json.updatedAt descending",
        ],
      },
      {
        intent: "find issue by id",
        steps: [
          `try workspace_read_json('${LINEAR_PATH_ROOT}/issues/<id>.json') first`,
          `if missing, workspace_list('${LINEAR_PATH_ROOT}/issues', depth=1) and read the file whose basename ends with '__<id>.json'`,
          `if you have a public identifier such as ENG-123, try workspace_read_json('${LINEAR_PATH_ROOT}/issues/${BY_ID_SEGMENT}/<identifier>.json') as an alias fallback`,
        ],
      },
      {
        intent: "find issue by slug-prefixed path",
        steps: [
          `workspace_read_json('${LINEAR_PATH_ROOT}/issues/<slug>__<id>.json') when both slug and id are known`,
          "derive <slug> from the human-readable Linear identifier or title by lowercasing, ASCII-folding accents, collapsing punctuation/whitespace to '-', trimming leading/trailing '-' and truncating so the full '<slug>__<id>.json' segment stays within 255 bytes",
          `if only the title slug is known, use workspace_read_json('${LINEAR_PATH_ROOT}/issues/${BY_TITLE_SEGMENT}/<slug>.json') to recover the canonical issue id`,
        ],
      },
      {
        intent: "find issue by title",
        steps: [
          `workspace_read_json('${LINEAR_PATH_ROOT}/issues/${BY_TITLE_SEGMENT}/<slug>.json')`,
          "derive <slug> by lowercasing the title, ASCII-folding accents, collapsing punctuation/whitespace to '-', trimming leading/trailing '-' and truncating to 80 chars",
          `if the alias payload exposes __id or identifier, retry workspace_read_json('${LINEAR_PATH_ROOT}/issues/${BY_ID_SEGMENT}/<identifier>.json') to recover the canonical issue`,
          "use the by-id alias as the disambiguation fallback when multiple issues collide on the same title slug",
        ],
      },
      {
        intent: "list issues in a given state",
        steps: [
          `workspace_list('${LINEAR_PATH_ROOT}/issues/${BY_STATE_SEGMENT}/<state>', depth=1)`,
          "workspace_read_json each returned file when you need the canonical issue payload",
          "normalize <state> by lowercasing, trimming whitespace, and collapsing separators to '-'",
        ],
      },
    ],
  };
}

function normalizeRequiredId(id: string): string {
  const normalized = id.trim();
  if (!normalized) {
    throw new Error("nameWithId requires a non-empty id");
  }
  return normalized;
}

function normalizeName(name: string | null | undefined): string {
  const normalized = name?.trim() ?? "";
  if (!normalized) {
    return "";
  }
  if (PLACEHOLDER_PATTERN.test(normalized)) {
    return normalized;
  }

  const slug =
    normalized
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .replace(/[\\/]+/gu, " ")
      .replace(/__/gu, " ")
      .match(/[\p{Letter}\p{Number}]+/gu)
      ?.join("-")
      .toLowerCase() ?? "";

  return trimTrailingSeparators(slug);
}

function truncateToBytes(value: string, maxBytes: number): string {
  let output = "";
  for (const character of value) {
    const candidate = output + character;
    if (byteLength(candidate) > maxBytes) {
      break;
    }
    output = candidate;
  }
  return output;
}

function byteLength(value: string): number {
  return PATH_SEGMENT_ENCODER.encode(value).length;
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/^[-_]+|[-_]+$/gu, "");
}
