import type { VfsConventionFragment } from "@cloud/cataloging-agent-core";
import { GITHUB_PATH_ROOT } from "@relayfile/adapter-github/path-mapper";

import { BY_ID_SEGMENT, BY_NAME_SEGMENT, BY_STATE_SEGMENT, BY_TITLE_SEGMENT } from "./aliases.js";
import packageJson from "../package.json" with { type: "json" };

/**
 * Build a placeholder-bearing path pattern keyed off the adapter's
 * canonical `GITHUB_PATH_ROOT`.
 *
 * The adapter's `githubPullRequestPath` etc. URI-encode every segment
 * (so `{n}` becomes `%7Bn%7D`), which is correct for real IDs but wrong
 * for the literal `{owner}` / `{repo}` / `{n}` / `{sha}` placeholders
 * the assistant substitutes at runtime. We derive the root from the
 * adapter and assemble the rest as a literal template.
 */
function repoPath(suffix: string): string {
  return `${GITHUB_PATH_ROOT}/repos/{owner}/{repo}${suffix}`;
}

/**
 * Resolve the `@relayfile/adapter-github` version this cataloging agent
 * was built against.
 *
 * Reads our own `package.json` (which we control and ship with our
 * source) rather than the adapter's package.json — the adapter's
 * `exports` map doesn't include `./package.json`, so importing it
 * directly is not portable across resolvers.
 *
 * The semver prefix (`^`, `~`, `>=`, etc.) is stripped so consumers see
 * the underlying version number.
 */
function resolveAdapterVersion(): string {
  const declared = packageJson.dependencies?.["@relayfile/adapter-github"];
  if (!declared) {
    throw new Error(
      "cataloging-agent-github expected @relayfile/adapter-github in its dependencies",
    );
  }
  return declared.replace(/^[\^~>=<]+/, "").trim();
}

const ADAPTER_VERSION = resolveAdapterVersion();

/**
 * Build the GitHub VFS convention fragment.
 *
 * The path patterns are derived from `@relayfile/adapter-github`'s
 * pure path helpers — `{owner}`, `{repo}`, `{n}`, and `{sha}` are
 * placeholders the assistant substitutes when issuing
 * `workspace_list` / `workspace_read_json` calls.
 */
export function buildGitHubConventionFragment(): VfsConventionFragment {
  return {
    provider: "github",
    version: ADAPTER_VERSION,
    generatedAt: new Date().toISOString(),
    paths: [
      {
        pattern: repoPath("/metadata.json"),
        description: "Repository metadata",
        objectType: "repository",
      },
      // KNOWN COLLISION: This alias subtree shares the `/repos/<segment>/...`
      // namespace with canonical repos. A real owner literally named
      // `by-name` with a repo containing `__` (e.g.
      // `/github/repos/by-name/acme__platform/metadata.json`) is
      // indistinguishable at the path level from this alias. The
      // cataloger never writes these alias files (they are emitted by
      // `@relayfile/adapter-github`); to make the alias layout truly
      // disjoint we would need to migrate the adapter to write under
      // `${GITHUB_PATH_ROOT}/repos/_aliases/${BY_NAME_SEGMENT}/...`
      // and update this pattern in lockstep. Until that adapter change
      // lands, alias detection is keyed off the literal `by-name`
      // segment in the repos/ position (see `active-prs.ts`).
      // TODO(issue #106): coordinate `_aliases/by-name` move with adapter-github.
      {
        pattern: `${GITHUB_PATH_ROOT}/repos/${BY_NAME_SEGMENT}/{owner}__{repo}/metadata.json`,
        description: "Repository alias keyed by owner__repo for direct lookup",
        objectType: "repository-alias-by-name",
      },
      {
        pattern: repoPath("/pulls/{n}/metadata.json"),
        description: "Pull request metadata (state: open|closed)",
        objectType: "pull_request",
      },
      {
        pattern: repoPath(`/pulls/${BY_TITLE_SEGMENT}/{slug}.json`),
        description: "Pull request alias keyed by slugified title; read JSON to recover canonical number",
        objectType: "pull-request-alias-by-title",
      },
      {
        pattern: repoPath(`/pulls/${BY_ID_SEGMENT}/{n}.json`),
        description: "Pull request alias keyed by canonical pull number for disambiguation",
        objectType: "pull-request-alias-by-id",
      },
      {
        pattern: repoPath(`/pulls/${BY_STATE_SEGMENT}/{state}/{n}.json`),
        description: "Pull request alias grouped by normalized state for state-scoped browsing",
        objectType: "pull-request-by-state",
      },
      {
        pattern: repoPath("/issues/{n}/metadata.json"),
        description: "Issue metadata",
        objectType: "issue",
      },
      {
        pattern: repoPath(`/issues/${BY_TITLE_SEGMENT}/{slug}.json`),
        description: "Issue alias keyed by slugified title; read JSON to recover canonical number",
        objectType: "issue-alias-by-title",
      },
      {
        pattern: repoPath(`/issues/${BY_ID_SEGMENT}/{n}.json`),
        description: "Issue alias keyed by canonical issue number for disambiguation",
        objectType: "issue-alias-by-id",
      },
      {
        pattern: repoPath(`/issues/${BY_STATE_SEGMENT}/{state}/{n}.json`),
        description: "Issue alias grouped by normalized state for state-scoped browsing",
        objectType: "issue-by-state",
      },
      {
        pattern: repoPath("/commits/{sha}/metadata.json"),
        description: "Commit metadata",
        objectType: "commit",
      },
    ],
    typicalQueries: [
      {
        intent: "list open PRs in a repo",
        steps: [
          `workspace_list('${GITHUB_PATH_ROOT}/repos/{owner}/{repo}/pulls/${BY_STATE_SEGMENT}/open', depth=1)`,
          "for each returned file, workspace_read_json(path)",
          "sort by json.updated_at descending",
        ],
      },
      {
        intent: "find PR by title",
        steps: [
          `workspace_read_json('${GITHUB_PATH_ROOT}/repos/{owner}/{repo}/pulls/${BY_TITLE_SEGMENT}/<slug>.json')`,
          "derive <slug> by lowercasing the title, ASCII-folding accents, collapsing punctuation/whitespace to '-', trimming leading/trailing '-' and truncating to 80 chars",
          `if the alias payload exposes __id or number, retry workspace_read_json('${GITHUB_PATH_ROOT}/repos/{owner}/{repo}/pulls/${BY_ID_SEGMENT}/<number>.json') to recover the canonical pull request`,
          "use the by-id alias as the disambiguation fallback when multiple pull requests collide on the same title slug",
        ],
      },
    ],
  };
}
