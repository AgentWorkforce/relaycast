import { normalizeVfsPath } from '@agent-assistant/vfs';
import { RelayFileApiError, type FileQueryItem, type FileReadResponse, type RelayFileClient, type TreeEntry } from '@relayfile/sdk';

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_CONTENT_SCAN_LIMIT = 40;
const DEFAULT_TREE_DEPTH = 8;

const GITHUB_ROOT = '/github/repos';
const SLACK_ROOT = '/slack';
const NOTION_ROOT = '/notion';
const LINEAR_ROOT = '/linear';

type KnownProvider = 'github' | 'slack' | 'notion' | 'linear';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface SearchScore {
  score: number;
  snippet?: string;
}

interface SearchCandidate {
  item: FileQueryItem;
  baseScore: SearchScore;
}

export interface RelayFileWorkspaceReaderOptions {
  client: RelayFileClient | null;
  workspaceId: string;
  cacheTtlMs?: number;
}

export interface VfsSearchResult {
  path: string;
  provider: string;
  title?: string;
  snippet?: string;
  revision: string;
  properties?: Record<string, string>;
}

export interface VfsListEntry {
  path: string;
  type: 'file' | 'dir';
  provider: string;
  title?: string;
  revision: string;
  updatedAt?: string;
  size?: number;
  properties?: Record<string, string>;
}

export interface VfsEnumerateInput {
  roots: string[];
  filters: Record<string, string[]>;
  limit: number;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeFileContent(file: FileReadResponse): string {
  if (file.encoding === 'base64') {
    return Buffer.from(file.content, 'base64').toString('utf-8');
  }
  return file.content;
}

function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function isBroadDiscoveryQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized === '*' || normalized === 'recent' || normalized === 'latest';
}

function normalizeSnippet(value: string, maxLength = 240): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
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

function scoreText(haystack: string, query: string, tokens: string[]): SearchScore {
  if (!haystack) {
    return { score: 0 };
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

  return {
    score,
    snippet: score > 0 ? extractSnippet(haystack, query, tokens) : undefined,
  };
}

function mergeScores(left: SearchScore, right: SearchScore): SearchScore {
  if (right.score > left.score) {
    return right;
  }

  if (left.score > 0) {
    return left;
  }

  return right;
}

function detectProvider(value: { path: string; provider?: string }): string {
  if (value.provider) {
    return value.provider;
  }
  if (value.path.startsWith('/github/')) {
    return 'github';
  }
  if (value.path.startsWith('/slack/')) {
    return 'slack';
  }
  if (value.path.startsWith('/notion/')) {
    return 'notion';
  }
  if (value.path.startsWith('/linear/')) {
    return 'linear';
  }
  return 'unknown';
}

function titleFromProperties(properties?: Record<string, string>): string | undefined {
  if (!properties) {
    return undefined;
  }

  const keys = [
    'title',
    'name',
    'linear.title',
    'linear.name',
    'linear.identifier',
    'linear.id',
    'channel_id',
    'provider.object_id',
    'object_id',
  ];

  for (const key of keys) {
    const value = readString(properties[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function titleFromPath(filePath: string): string | undefined {
  const normalized = normalizeVfsPath(filePath);
  const basename = normalized.split('/').filter(Boolean).pop();
  if (!basename) {
    return undefined;
  }
  return safeDecodeURIComponent(basename);
}

function toSearchResult(item: FileQueryItem, snippet?: string): VfsSearchResult {
  return {
    path: item.path,
    provider: detectProvider(item),
    title: titleFromProperties(item.properties) ?? titleFromPath(item.path),
    snippet,
    revision: item.revision,
    properties: item.properties,
  };
}

function treeEntryToQueryItem(entry: TreeEntry, providerOverride?: string): FileQueryItem {
  return {
    path: entry.path,
    revision: entry.revision,
    contentType: entry.type === 'dir' ? 'inode/directory' : 'application/octet-stream',
    provider: providerOverride ?? entry.provider,
    providerObjectId: entry.providerObjectId,
    lastEditedAt: entry.updatedAt,
    size: entry.size ?? 0,
  };
}

function treeEntryToListEntry(entry: TreeEntry): VfsListEntry {
  const properties = (entry as TreeEntry & { properties?: Record<string, string> }).properties;

  return {
    path: entry.path,
    type: entry.type,
    provider: detectProvider(entry),
    title: titleFromPath(entry.path),
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    size: entry.size,
    properties,
  };
}

function queryItemToListEntry(item: FileQueryItem): VfsListEntry {
  return {
    path: item.path,
    type: item.contentType === 'inode/directory' ? 'dir' : 'file',
    provider: detectProvider(item),
    title: titleFromProperties(item.properties) ?? titleFromPath(item.path),
    revision: item.revision,
    updatedAt: item.lastEditedAt,
    size: item.size,
    properties: item.properties,
  };
}

function providerRoot(provider?: string): string | undefined {
  switch (provider as KnownProvider | undefined) {
    case 'github':
      return GITHUB_ROOT;
    case 'slack':
      return SLACK_ROOT;
    case 'notion':
      return NOTION_ROOT;
    case 'linear':
      return LINEAR_ROOT;
    default:
      return undefined;
  }
}

function buildItemSearchText(item: FileQueryItem): string {
  const fields: string[] = [item.path];

  if (item.provider) {
    fields.push(item.provider);
  }
  if (item.providerObjectId) {
    fields.push(item.providerObjectId);
  }
  if (item.properties) {
    fields.push(
      ...Object.entries(item.properties).flatMap(([key, value]) => [key, value]),
    );
  }

  return fields.join('\n');
}

function dedupeByPath<T extends { path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const item of items) {
    if (seen.has(item.path)) {
      continue;
    }
    seen.add(item.path);
    deduped.push(item);
  }

  return deduped;
}

function sortSearchResults(left: SearchCandidate, right: SearchCandidate): number {
  if (right.baseScore.score !== left.baseScore.score) {
    return right.baseScore.score - left.baseScore.score;
  }
  return left.item.path.localeCompare(right.item.path);
}

function itemTimestamp(item: FileQueryItem): number {
  const candidates = [
    item.lastEditedAt,
    item.properties?.['notion.last_edited_time'],
    item.properties?.lastEditedAt,
    item.properties?.last_edited_at,
    item.properties?.updatedAt,
    item.properties?.updated_at,
    item.properties?.createdAt,
    item.properties?.created_at,
  ];

  for (const value of candidates) {
    if (!value) {
      continue;
    }

    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  return 0;
}

function sortItemsByRecencyThenPath(left: FileQueryItem, right: FileQueryItem): number {
  const recencyDelta = itemTimestamp(right) - itemTimestamp(left);
  return recencyDelta !== 0 ? recencyDelta : left.path.localeCompare(right.path);
}

function buildPropertyFilterCells(filters: Record<string, string[]>): Array<Record<string, string>> {
  const entries = Object.entries(filters);
  if (entries.length === 0) {
    return [{}];
  }

  const cells: Array<Record<string, string>> = [{}];
  for (const [key, values] of entries) {
    if (values.length === 0) {
      return [];
    }

    const nextCells: Array<Record<string, string>> = [];
    for (const cell of cells) {
      for (const value of values) {
        nextCells.push({ ...cell, [key]: value });
      }
    }
    cells.splice(0, cells.length, ...nextCells);
  }

  return cells;
}

export class RelayFileWorkspaceReader {
  private readonly client: RelayFileClient | null;
  private readonly workspaceId: string;
  private readonly cacheTtlMs: number;
  private readonly searchCache = new Map<string, CacheEntry<VfsSearchResult[]>>();
  private readonly fileCache = new Map<string, CacheEntry<FileReadResponse>>();

  constructor(options: RelayFileWorkspaceReaderOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId.trim();
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  isEnabled(): boolean {
    return Boolean(this.client && this.workspaceId);
  }

  async searchFiles(
    query: string,
    provider?: string,
    limit = DEFAULT_SEARCH_LIMIT,
  ): Promise<VfsSearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const normalizedProvider = provider?.trim() || undefined;
    const cacheKey = `search:${normalizedProvider ?? 'all'}:${limit}:${trimmedQuery.toLowerCase()}`;
    const cached = this.getCache(this.searchCache, cacheKey);
    if (cached) {
      return cached;
    }

    const scanLimit = Math.min(DEFAULT_SCAN_LIMIT, Math.max(limit * 10, 50));
    const items = await this.collectSearchItems(
      normalizedProvider,
      providerRoot(normalizedProvider),
      scanLimit,
    );
    const results = await this.rankSearchResults(trimmedQuery, items, limit);
    this.setCache(this.searchCache, cacheKey, results);
    return results;
  }

  async readFile(filePath: string): Promise<string | null> {
    const normalizedPath = normalizeVfsPath(filePath);
    try {
      const file = await this.readFileResponse(normalizedPath);
      return decodeFileContent(file);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listTree(
    treePath: string,
    depth = DEFAULT_TREE_DEPTH,
    limit = DEFAULT_LIST_LIMIT,
  ): Promise<VfsListEntry[]> {
    const normalizedPath = normalizeVfsPath(treePath);
    const entries = await this.collectTreeEntries(normalizedPath, depth, limit);
    return entries
      .filter((entry) => entry.path !== normalizedPath)
      .map((entry) => treeEntryToListEntry(entry));
  }

  async enumerate(input: VfsEnumerateInput): Promise<VfsListEntry[]> {
    if (input.limit <= 0) {
      return [];
    }

    const propertyFilterCells = buildPropertyFilterCells(input.filters);
    if (propertyFilterCells.length === 0) {
      return [];
    }

    const itemsByPath = new Map<string, FileQueryItem>();
    for (const root of input.roots) {
      const normalizedRoot = normalizeVfsPath(root);
      for (const properties of propertyFilterCells) {
        const queried = await this.collectQueryItems(
          {
            path: normalizedRoot,
            properties: Object.keys(properties).length > 0 ? properties : undefined,
          },
          input.limit,
        );

        for (const item of queried) {
          if (!itemsByPath.has(item.path)) {
            itemsByPath.set(item.path, item);
          }
        }
      }
    }

    // Sort merged results across all (root, filter-cell) combinations BEFORE
    // slicing, so OR-within-key fan-out (e.g. `state: ['open', 'closed']`)
    // doesn't behave like "first value only" when the first cell already
    // returns >= input.limit matches. Newest-first by lastEditedAt with a
    // path tiebreaker mirrors the librarian engine's compareEntries.
    return [...itemsByPath.values()]
      .sort(sortItemsByRecencyThenPath)
      .slice(0, input.limit)
      .map((item) => queryItemToListEntry(item));
  }

  async statFile(filePath: string): Promise<VfsListEntry | null> {
    const normalizedPath = normalizeVfsPath(filePath);
    if (normalizedPath === '/') {
      return {
        path: '/',
        type: 'dir',
        provider: 'unknown',
        title: '/',
        revision: '',
      };
    }

    const parent = normalizedPath.split('/').slice(0, -1).join('/') || '/';
    const entries = await this.collectTreeEntries(parent, 1, DEFAULT_LIST_LIMIT);
    const match = entries.find((entry) => normalizeVfsPath(entry.path) === normalizedPath);
    if (match) {
      return treeEntryToListEntry(match);
    }

    const content = await this.readFile(normalizedPath);
    if (content === null) {
      return null;
    }

    return {
      path: normalizedPath,
      type: 'file',
      provider: detectProvider({ path: normalizedPath }),
      title: titleFromPath(normalizedPath),
      revision: '',
      size: Buffer.byteLength(content),
    };
  }

  private getCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, value });
  }

  private isNotFoundError(error: unknown): boolean {
    if (error instanceof RelayFileApiError && error.status === 404) {
      return true;
    }

    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const record = error as Record<string, unknown>;
    return record.status === 404 || record.statusCode === 404;
  }

  private async readFileResponse(filePath: string): Promise<FileReadResponse> {
    const normalizedPath = normalizeVfsPath(filePath);
    const cached = this.getCache(this.fileCache, normalizedPath);
    if (cached) {
      return cached;
    }

    const client = this.client;
    if (!client) {
      throw new Error('RelayFile client is not configured');
    }

    const response = await client.readFile(this.workspaceId, normalizedPath);
    const normalized: FileReadResponse = {
      ...response,
      content: decodeFileContent(response),
      encoding: 'utf-8',
    };

    this.setCache(this.fileCache, normalizedPath, normalized);
    return normalized;
  }

  private async tryReadFile(filePath: string): Promise<string | null> {
    try {
      const file = await this.readFileResponse(filePath);
      return file.content;
    } catch (error) {
      if (this.isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async collectQueryItems(
    options: {
      path?: string;
      provider?: string;
      properties?: Record<string, string>;
    },
    limit: number,
  ): Promise<FileQueryItem[]> {
    const client = this.client;
    if (!client || limit <= 0) {
      return [];
    }

    const items: FileQueryItem[] = [];
    let cursor: string | undefined;

    while (items.length < limit) {
      const page = await client.queryFiles(this.workspaceId, {
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

    return dedupeByPath(items).slice(0, limit);
  }

  private async collectTreeEntries(
    treePath: string,
    depth: number,
    limit: number,
  ): Promise<TreeEntry[]> {
    const client = this.client;
    if (!client || limit <= 0) {
      return [];
    }

    const entries: TreeEntry[] = [];
    let cursor: string | undefined;

    while (entries.length < limit) {
      const page = await client.listTree(this.workspaceId, {
        path: normalizeVfsPath(treePath),
        depth,
        cursor,
      });

      entries.push(...page.entries);
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    }

    return dedupeByPath(entries).slice(0, limit);
  }

  private async collectSearchItems(
    provider: string | undefined,
    rootPath: string | undefined,
    limit: number,
  ): Promise<FileQueryItem[]> {
    const collected = new Map<string, FileQueryItem>();
    let queryNotFoundError: unknown = null;

    try {
      const queried = await this.collectQueryItems(
        {
          provider,
          path: rootPath,
        },
        limit,
      );

      for (const item of queried) {
        collected.set(item.path, item);
      }
    } catch (error) {
      if (!this.isNotFoundError(error) || !rootPath) {
        throw error;
      }
      queryNotFoundError = error;
    }

    if (rootPath && collected.size < limit) {
      const treeEntries = await this.collectTreeEntries(rootPath, DEFAULT_TREE_DEPTH, limit * 2);
      for (const entry of treeEntries) {
        if (entry.type !== 'file') {
          continue;
        }
        collected.set(entry.path, treeEntryToQueryItem(entry, provider));
      }
    }

    if (queryNotFoundError && collected.size === 0) {
      throw queryNotFoundError;
    }

    return [...collected.values()].slice(0, limit);
  }

  private async rankSearchResults(
    query: string,
    items: FileQueryItem[],
    limit: number,
  ): Promise<VfsSearchResult[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery || items.length === 0) {
      return [];
    }

    if (isBroadDiscoveryQuery(normalizedQuery)) {
      return [...items]
        .sort(sortItemsByRecencyThenPath)
        .slice(0, limit)
        .map((item) => toSearchResult(item));
    }

    const tokens = tokenizeQuery(normalizedQuery);

    const candidates = items.map((item) => ({
      item,
      baseScore: scoreText(buildItemSearchText(item), normalizedQuery, tokens),
    }));

    candidates.sort(sortSearchResults);

    const contentReads = await Promise.all(
      candidates
        .slice(0, Math.min(DEFAULT_CONTENT_SCAN_LIMIT, Math.max(limit * 4, 20)))
        .map(async (candidate) => {
          const content = await this.tryReadFile(candidate.item.path);
          if (!content) {
            return candidate;
          }

          const contentScore = scoreText(content, normalizedQuery, tokens);
          return {
            ...candidate,
            baseScore: mergeScores(candidate.baseScore, {
              score: candidate.baseScore.score + contentScore.score,
              snippet: contentScore.snippet ?? candidate.baseScore.snippet,
            }),
          };
        }),
    );

    const scoredByPath = new Map<string, SearchCandidate>();
    for (const candidate of [...candidates, ...contentReads]) {
      const existing = scoredByPath.get(candidate.item.path);
      if (!existing || candidate.baseScore.score > existing.baseScore.score) {
        scoredByPath.set(candidate.item.path, candidate);
      }
    }

    return [...scoredByPath.values()]
      .filter((candidate) => candidate.baseScore.score > 0)
      .sort(sortSearchResults)
      .slice(0, limit)
      .map((candidate) => toSearchResult(candidate.item, candidate.baseScore.snippet));
  }
}
