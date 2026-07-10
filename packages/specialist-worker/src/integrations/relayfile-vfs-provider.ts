import type {
  VfsEntry,
  VfsProvider,
  VfsReadResult,
  VfsSearchOptions,
  VfsSearchResult,
} from "@agent-assistant/vfs";
import { normalizeVfsPath } from "@agent-assistant/vfs";
import { RelayFileApiError, type FileQueryItem, type RelayFileClient } from "@relayfile/sdk";

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_CONTENT_SCAN_LIMIT = 40;
const DEFAULT_TREE_DEPTH = 8;

const KNOWN_PROVIDERS = ["github", "slack", "notion", "linear"] as const;

function decodeFileContent(file: { content: string; encoding?: "utf-8" | "base64" }): string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64").toString("utf-8");
  }
  return file.content;
}

function titleFromPath(filePath: string): string | undefined {
  const basename = normalizeVfsPath(filePath).split("/").filter(Boolean).pop();
  if (!basename) {
    return undefined;
  }

  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function providerFromPath(filePath: string): string {
  const match = normalizeVfsPath(filePath).match(/^\/([^/]+)/);
  return match?.[1] ?? "unknown";
}

function inferContentType(filePath: string): string {
  const path = normalizeVfsPath(filePath).toLowerCase();
  if (path.endsWith(".json")) {
    return "application/json";
  }
  if (path.endsWith(".md") || path.endsWith(".markdown")) {
    return "text/markdown";
  }
  if (path.endsWith(".patch") || path.endsWith(".diff")) {
    return "text/x-patch";
  }
  return "text/plain";
}

function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeSnippet(value: string, maxLength = 240): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 3)}...`;
}

function extractSnippet(haystack: string, query: string, tokens: string[]): string | undefined {
  const lower = haystack.toLowerCase();
  const matches = [query, ...tokens]
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  const firstMatch = matches[0];
  if (firstMatch === undefined) {
    return undefined;
  }

  const start = Math.max(0, firstMatch - 80);
  const end = Math.min(haystack.length, firstMatch + 160);
  return normalizeSnippet(haystack.slice(start, end));
}

function scoreText(haystack: string, query: string, tokens: string[]): number {
  if (!haystack) {
    return 0;
  }

  const lower = haystack.toLowerCase();
  let score = 0;

  if (lower.includes(query)) {
    score += query.length * 6;
  }

  for (const token of tokens) {
    if (lower.includes(token)) {
      score += token.length * 2;
    }
  }

  return score;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof RelayFileApiError && error.status === 404;
}

async function collectQueryItems(
  client: RelayFileClient,
  workspaceId: string,
  options: {
    path?: string;
    provider?: string;
    properties?: Record<string, string>;
  },
  limit: number,
): Promise<FileQueryItem[]> {
  if (limit <= 0) {
    return [];
  }

  const items: FileQueryItem[] = [];
  let cursor: string | undefined;

  while (items.length < limit) {
    const page = await client.queryFiles(workspaceId, {
      path: options.path,
      provider: options.provider,
      properties: options.properties,
      cursor,
      limit: Math.min(100, limit - items.length),
    });

    items.push(...page.items);
    if (!page.nextCursor) {
      break;
    }
    cursor = page.nextCursor;
  }

  const seen = new Set<string>();
  const deduped: FileQueryItem[] = [];
  for (const item of items) {
    if (seen.has(item.path)) {
      continue;
    }
    seen.add(item.path);
    deduped.push(item);
  }

  return deduped.slice(0, limit);
}

async function searchProvider(
  client: RelayFileClient,
  workspaceId: string,
  provider: string,
  query: string,
  limit: number,
): Promise<VfsSearchResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const tokens = tokenizeQuery(normalizedQuery);
  const scanLimit = Math.max(DEFAULT_SCAN_LIMIT, limit * 10);
  const candidates = await collectQueryItems(
    client,
    workspaceId,
    {
      path: `/${provider}`,
      provider,
    },
    scanLimit,
  );

  const scored = candidates
    .map((item) => {
      const title = titleFromPath(item.path);
      const propertyText = item.properties ? Object.values(item.properties).join("\n") : "";
      const commentText = item.comments ? item.comments.join("\n") : "";
      const baseScore =
        scoreText(item.path, normalizedQuery, tokens) +
        scoreText(title ?? "", normalizedQuery, tokens) +
        scoreText(propertyText, normalizedQuery, tokens) +
        scoreText(commentText, normalizedQuery, tokens);

      return { item, title, baseScore };
    })
    .filter((entry) => entry.baseScore > 0 || normalizedQuery.length === 0);

  scored.sort((a, b) => b.baseScore - a.baseScore);

  const contentScan = scored.slice(0, DEFAULT_CONTENT_SCAN_LIMIT);
  const contentByPath = new Map<string, { score: number; snippet?: string }>();

  await Promise.all(
    contentScan.map(async ({ item }) => {
      try {
        const file = await client.readFile(workspaceId, item.path);
        const content = decodeFileContent(file);
        const contentScore = scoreText(content, normalizedQuery, tokens);
        const snippet =
          contentScore > 0 ? extractSnippet(content, normalizedQuery, tokens) : undefined;
        contentByPath.set(item.path, { score: contentScore, snippet });
      } catch (error) {
        if (!isNotFoundError(error)) {
          // Ignore other errors to keep search best-effort.
        }
      }
    }),
  );

  const results = scored
    .map(({ item, title, baseScore }) => {
      const content = contentByPath.get(item.path);
      const score = baseScore + (content?.score ?? 0);

      return {
        path: item.path,
        type: "file",
        provider: item.provider ?? providerFromPath(item.path),
        title,
        revision: item.revision,
        updatedAt: item.lastEditedAt,
        size: item.size,
        properties: {
          ...(item.properties ?? {}),
          score: String(score),
        },
        ...(content?.snippet ? { snippet: content.snippet } : {}),
      } satisfies VfsSearchResult;
    })
    .sort((a, b) => Number(b.properties?.score ?? 0) - Number(a.properties?.score ?? 0))
    .slice(0, limit);

  return results;
}

export interface RelayfileVfsProviderOptions {
  client: RelayFileClient | null;
  workspaceId: string;
}

export function createRelayfileVfsProvider(options: RelayfileVfsProviderOptions): VfsProvider {
  const { client, workspaceId } = options;

  function getConfiguredClient(): RelayFileClient {
    if (!client || !workspaceId.trim()) {
      throw new Error(
        "RelayFile is not configured. Provide a RelayFileClient and a workspaceId.",
      );
    }
    return client;
  }

  return {
    async list(path, listOptions) {
      const relayFile = getConfiguredClient();
      const normalizedPath = normalizeVfsPath(path);
      const depth = listOptions?.depth ?? DEFAULT_TREE_DEPTH;
      const limit = listOptions?.limit ?? DEFAULT_LIST_LIMIT;

      const entries: VfsEntry[] = [];
      let cursor: string | undefined;

      while (entries.length < limit) {
        const page = await relayFile.listTree(workspaceId, {
          path: normalizedPath,
          depth,
          cursor,
        });

        for (const entry of page.entries) {
          entries.push({
            path: entry.path,
            type: entry.type === "file" ? "file" : entry.type === "dir" ? "dir" : "unknown",
            provider: entry.provider ?? providerFromPath(entry.path),
            title: titleFromPath(entry.path),
            revision: entry.revision,
            updatedAt: entry.updatedAt,
            size: entry.size,
          });

          if (entries.length >= limit) {
            break;
          }
        }

        if (!page.nextCursor) {
          break;
        }

        cursor = page.nextCursor;
      }

      return entries.slice(0, limit);
    },

    async read(path) {
      const relayFile = getConfiguredClient();
      const normalizedPath = normalizeVfsPath(path);
      try {
        const file = await relayFile.readFile(workspaceId, normalizedPath);
        const content = decodeFileContent(file);

        return {
          path: normalizedPath,
          content,
          contentType: file.contentType ?? inferContentType(normalizedPath),
          encoding: "utf-8",
          provider: file.provider ?? providerFromPath(normalizedPath),
          title: titleFromPath(normalizedPath),
          revision: file.revision,
          updatedAt: file.lastEditedAt,
          ...(file.semantics?.properties ? { properties: file.semantics.properties } : {}),
        } satisfies VfsReadResult;
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },

    async search(query: string, searchOptions?: VfsSearchOptions) {
      const relayFile = getConfiguredClient();
      const limit = searchOptions?.limit ?? DEFAULT_SEARCH_LIMIT;
      const provider = searchOptions?.provider?.trim();

      if (provider) {
        return searchProvider(relayFile, workspaceId, provider, query, limit);
      }

      const results = await Promise.all(
        KNOWN_PROVIDERS.map((candidate) =>
          searchProvider(relayFile, workspaceId, candidate, query, limit),
        ),
      );

      const flattened = results.flat();
      flattened.sort(
        (a, b) => Number(b.properties?.score ?? 0) - Number(a.properties?.score ?? 0),
      );

      return flattened.slice(0, limit);
    },

    async stat(path: string) {
      const relayFile = getConfiguredClient();
      const normalizedPath = normalizeVfsPath(path);

      try {
        const file = await relayFile.readFile(workspaceId, normalizedPath);
        const content = decodeFileContent(file);
        return {
          path: normalizedPath,
          type: "file",
          provider: file.provider ?? providerFromPath(normalizedPath),
          title: titleFromPath(normalizedPath),
          revision: file.revision,
          updatedAt: file.lastEditedAt,
          size: Buffer.byteLength(content),
          ...(file.semantics?.properties ? { properties: file.semantics.properties } : {}),
        } satisfies VfsEntry;
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }

      try {
        const listing = await relayFile.listTree(workspaceId, { path: normalizedPath, depth: 1 });
        if (listing.entries.length > 0) {
          return {
            path: normalizedPath,
            type: "dir",
            provider: providerFromPath(normalizedPath),
            title: titleFromPath(normalizedPath),
          } satisfies VfsEntry;
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }

      return null;
    },
  };
}
