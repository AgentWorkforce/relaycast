import type {
  VfsEntry,
  VfsProvider,
  VfsReadResult,
  VfsSearchResult,
} from '@agent-assistant/vfs';
import { normalizeVfsPath } from '@agent-assistant/vfs';

import type {
  VfsEnumerateInput,
  VfsListEntry,
  VfsSearchResult as RelayFileSearchResult,
} from './relayfile-workspace-reader.js';

export interface RelayFileVfsReader {
  isEnabled(): boolean;
  listTree(path: string, depth?: number, limit?: number): Promise<VfsListEntry[]>;
  enumerate?(input: VfsEnumerateInput): Promise<VfsListEntry[]>;
  readFile(path: string): Promise<string | null>;
  searchFiles(query: string, provider?: string, limit?: number): Promise<RelayFileSearchResult[]>;
  statFile(path: string): Promise<VfsListEntry | null>;
}

export interface RelayFileVfsProvider extends VfsProvider {
  enumerate(input: VfsEnumerateInput): Promise<VfsEntry[]>;
}

export function createRelayFileVfsProvider(reader: RelayFileVfsReader): RelayFileVfsProvider {
  return {
    async list(path, options) {
      assertReaderEnabled(reader);
      const entries = await reader.listTree(path, options?.depth, options?.limit);
      return entries.map((entry) => toVfsEntry(entry));
    },

    async enumerate(input) {
      assertReaderEnabled(reader);
      if (!reader.enumerate) {
        throw new Error('RelayFile reader does not support VFS enumeration.');
      }

      const entries = await reader.enumerate(input);
      return entries.map((entry) => toVfsEntry(entry));
    },

    async read(path) {
      assertReaderEnabled(reader);
      const normalizedPath = normalizeVfsPath(path);
      const content = await reader.readFile(normalizedPath);
      if (content === null) {
        return null;
      }

      return toVfsReadResult(normalizedPath, content);
    },

    async search(query, options) {
      assertReaderEnabled(reader);
      const results = await reader.searchFiles(query, options?.provider, options?.limit);
      return results.map((result) => toVfsSearchResult(result));
    },

    async stat(path) {
      assertReaderEnabled(reader);
      const normalizedPath = normalizeVfsPath(path);
      const entry = await reader.statFile(normalizedPath);
      if (entry) {
        return toVfsEntry(entry);
      }

      const content = await reader.readFile(normalizedPath);
      if (content === null) {
        return null;
      }

      return {
        path: normalizedPath,
        type: 'file',
        provider: providerFromPath(normalizedPath),
        title: titleFromPath(normalizedPath),
        size: Buffer.byteLength(content),
      };
    },
  };
}

function assertReaderEnabled(reader: RelayFileVfsReader): void {
  if (!reader.isEnabled()) {
    throw new Error(
      'RelayFile is not configured. Provide a RelayFileClient and a non-empty workspaceId.',
    );
  }
}

function toVfsEntry(entry: VfsListEntry): VfsEntry {
  return {
    path: entry.path,
    type: entry.type,
    provider: entry.provider,
    title: entry.title,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    size: entry.size,
    properties: entry.properties,
  };
}

function toVfsSearchResult(result: RelayFileSearchResult): VfsSearchResult {
  return {
    path: result.path,
    type: 'file',
    provider: result.provider,
    title: result.title,
    revision: result.revision,
    properties: result.properties,
    snippet: result.snippet,
  };
}

function toVfsReadResult(path: string, content: string): VfsReadResult {
  return {
    path,
    content,
    contentType: inferContentType(path),
    encoding: 'utf-8',
    provider: providerFromPath(path),
    title: titleFromPath(path),
  };
}

function providerFromPath(filePath: string): string {
  const match = normalizeVfsPath(filePath).match(/^\/([^/]+)/);
  return match?.[1] ?? 'unknown';
}

function titleFromPath(filePath: string): string | undefined {
  const basename = normalizeVfsPath(filePath).split('/').filter(Boolean).pop();
  if (!basename) {
    return undefined;
  }

  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function inferContentType(filePath: string): string {
  const path = normalizeVfsPath(filePath).toLowerCase();
  if (path.endsWith('.json')) {
    return 'application/json';
  }
  if (path.endsWith('.md') || path.endsWith('.markdown')) {
    return 'text/markdown';
  }
  if (path.endsWith('.patch') || path.endsWith('.diff')) {
    return 'text/x-patch';
  }
  return 'text/plain';
}
