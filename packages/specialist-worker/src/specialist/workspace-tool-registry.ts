import type {
  HarnessToolCall,
  HarnessToolDefinition,
  HarnessToolRegistry,
  HarnessToolResult,
} from '@agent-assistant/harness';

import type { RelayFileWorkspaceReader } from './relayfile-workspace-reader.js';

export interface WorkspaceToolRegistryOptions {
  reader: RelayFileWorkspaceReader;
  defaultSearchLimit?: number;
  maxListDepth?: number;
}

type WorkspaceProvider = 'github' | 'slack' | 'notion' | 'linear';

type ReaderSearchResult = Awaited<ReturnType<RelayFileWorkspaceReader['searchFiles']>>[number];
type ReaderListEntry = Awaited<ReturnType<RelayFileWorkspaceReader['listTree']>>[number];

interface WorkspaceSearchOutput {
  path: string;
  provider: string;
  score?: number;
  preview?: string;
}

interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

interface ValidationFailure {
  ok: false;
  message: string;
}

type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_MAX_LIST_DEPTH = 3;
const DEFAULT_READ_MAX_BYTES = 50 * 1024;
const MAX_SEARCH_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const MAX_READ_BYTES = 100 * 1024;
const MAX_SCHEMA_LIST_DEPTH = 5;
const MAX_OUTPUT_BYTES = 50 * 1024;

const WORKSPACE_PROVIDERS = ['github', 'slack', 'notion', 'linear'] as const;

const WORKSPACE_SEARCH_TOOL: HarnessToolDefinition = {
  name: 'workspace_search',
  description:
    'Search the workspace VFS across all providers (github, slack, notion, linear). Use for enumeration and keyword queries.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', minLength: 1 },
      provider: { type: 'string', enum: WORKSPACE_PROVIDERS },
      limit: { type: 'number', minimum: 1, maximum: MAX_SEARCH_LIMIT },
    },
  },
};

const WORKSPACE_LIST_TOOL: HarnessToolDefinition = {
  name: 'workspace_list',
  description:
    'List entries under a VFS path. Use to browse provider namespaces (e.g. /github, /linear/issues).',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1 },
      depth: { type: 'number', minimum: 1, maximum: MAX_SCHEMA_LIST_DEPTH },
      limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT },
    },
  },
};

const WORKSPACE_READ_TOOL: HarnessToolDefinition = {
  name: 'workspace_read',
  description: 'Read a single file from the VFS by full path.',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1 },
      offset: { type: 'number', minimum: 0 },
      maxBytes: { type: 'number', minimum: 1, maximum: MAX_READ_BYTES },
    },
  },
};

const WORKSPACE_TOOLS = [
  WORKSPACE_SEARCH_TOOL,
  WORKSPACE_LIST_TOOL,
  WORKSPACE_READ_TOOL,
] satisfies HarnessToolDefinition[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkspaceProvider(value: unknown): value is WorkspaceProvider {
  return (
    typeof value === 'string' &&
    (WORKSPACE_PROVIDERS as readonly string[]).includes(value)
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function normalizeOption(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(max, Math.floor(value));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stringifyOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stringifyArrayOutput(items: readonly unknown[]): string {
  const fullOutput = stringifyOutput(items);
  if (byteLength(fullOutput) <= MAX_OUTPUT_BYTES) {
    return fullOutput;
  }

  const truncatedItems = [...items];
  while (truncatedItems.length > 0) {
    const omitted = items.length - truncatedItems.length;
    const candidate = stringifyOutput([
      ...truncatedItems,
      {
        _truncated: true,
        omitted,
        message: 'Output exceeded 50KB; narrow the query or lower the limit.',
      },
    ]);

    if (byteLength(candidate) <= MAX_OUTPUT_BYTES) {
      return candidate;
    }

    truncatedItems.pop();
  }

  return stringifyOutput([
    {
      _truncated: true,
      omitted: items.length,
      message: 'Output exceeded 50KB; narrow the query or lower the limit.',
    },
  ]);
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function sliceUtf8(value: string, offset: number, maxBytes: number): {
  output: string;
  bytesReturned: number;
  totalBytes: number;
  nextOffset?: number;
  truncated: boolean;
} {
  const encoded = new TextEncoder().encode(value);
  const totalBytes = encoded.byteLength;
  let safeOffset = Math.min(offset, totalBytes);
  while (safeOffset < totalBytes && isUtf8ContinuationByte(encoded[safeOffset])) {
    safeOffset += 1;
  }

  let end = Math.min(totalBytes, safeOffset + maxBytes);
  while (end > safeOffset && end < totalBytes && isUtf8ContinuationByte(encoded[end])) {
    end -= 1;
  }
  if (end === safeOffset && safeOffset < totalBytes) {
    end = Math.min(totalBytes, safeOffset + maxBytes);
    while (end < totalBytes && isUtf8ContinuationByte(encoded[end])) {
      end += 1;
    }
  }

  const output = new TextDecoder().decode(encoded.slice(safeOffset, end));
  return {
    output,
    bytesReturned: end - safeOffset,
    totalBytes,
    ...(end < totalBytes ? { nextOffset: end } : {}),
    truncated: safeOffset > 0 || end < totalBytes,
  };
}

function stringifyReadOutput(content: string, offset: number, maxBytes: number): string {
  const sliced = sliceUtf8(content, offset, maxBytes);
  if (!sliced.truncated) {
    return sliced.output;
  }

  const footerLines = [
    '[workspace_read_truncated]',
    `bytes_returned=${sliced.bytesReturned}`,
    `total_bytes=${sliced.totalBytes}`,
    `offset=${offset}`,
    ...(sliced.nextOffset !== undefined ? [`next_offset=${sliced.nextOffset}`] : []),
    'message=Output exceeded workspace_read byte window; call workspace_read again with offset=next_offset to continue.',
  ];
  return `${sliced.output}\n\n${footerLines.join('\n')}`;
}

function successResult(call: HarnessToolCall, output: string): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: 'success',
    output,
  };
}

function errorResult(
  call: HarnessToolCall,
  code: string,
  message: string,
  retryable: boolean,
): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: 'error',
    error: {
      code,
      message,
      retryable,
    },
  };
}

function workspaceUnavailableResult(call: HarnessToolCall): HarnessToolResult {
  return errorResult(
    call,
    'workspace_unavailable',
    'Workspace VFS not configured',
    false,
  );
}

function unknownToolResult(call: HarnessToolCall): HarnessToolResult {
  return errorResult(call, 'unknown_tool', `Unknown tool: ${call.name}`, false);
}

function invalidInputResult(call: HarnessToolCall, message: string): HarnessToolResult {
  return errorResult(call, 'invalid_input', message, false);
}

/**
 * Returning `status: 'error'` with `retryable: false` here would trip the
 * harness's `tool_error_unrecoverable` short-circuit (see `harness.ts`'s
 * `if (result.error?.retryable !== true)` branch) and abort the entire turn
 * the moment the model speculatively reads a path that has not been synced
 * into the VFS yet (e.g. a PR metadata.json the cataloging adapter missed).
 *
 * Returning a successful result with a textual "file not found" body lets the
 * model treat absence as a soft signal — skip that file, try a different
 * one, or fall back to enumerate-only output — instead of nuking the turn.
 * This is the cloud-side mitigation for the agent-assistant harness's
 * "all errors with retryable=false abort" contract; the alternative would
 * be a third "soft_error" status on HarnessToolResult.
 */
function notFoundResult(call: HarnessToolCall, path: string): HarnessToolResult {
  return successResult(call, `Workspace file not found: ${path}`);
}

function thrownErrorResult(call: HarnessToolCall, error: unknown): HarnessToolResult {
  return errorResult(call, 'tool_error', toErrorMessage(error), true);
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): ValidationResult<string> {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length < 1) {
    return { ok: false, message: `input.${key} must be a non-empty string` };
  }
  return { ok: true, value };
}

function readOptionalInteger(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): ValidationResult<number> {
  const value = input[key];
  if (value === undefined) {
    return { ok: true, value: fallback };
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return {
      ok: false,
      message: `input.${key} must be an integer between ${min} and ${max}`,
    };
  }
  return { ok: true, value };
}

function validateSearchInput(
  input: unknown,
  defaultSearchLimit: number,
): ValidationResult<{
  query: string;
  provider?: WorkspaceProvider;
  limit: number;
}> {
  if (!isRecord(input)) {
    return { ok: false, message: 'input must be an object' };
  }

  const query = readRequiredString(input, 'query');
  if (!query.ok) {
    return query;
  }

  if (input.provider !== undefined && !isWorkspaceProvider(input.provider)) {
    return {
      ok: false,
      message: 'input.provider must be one of: github, slack, notion, linear',
    };
  }

  const limit = readOptionalInteger(
    input,
    'limit',
    defaultSearchLimit,
    1,
    MAX_SEARCH_LIMIT,
  );
  if (!limit.ok) {
    return limit;
  }

  return {
    ok: true,
    value: {
      query: query.value,
      ...(input.provider ? { provider: input.provider } : {}),
      limit: limit.value,
    },
  };
}

function validateListInput(
  input: unknown,
): ValidationResult<{
  path: string;
  depth: number;
  limit: number;
}> {
  if (!isRecord(input)) {
    return { ok: false, message: 'input must be an object' };
  }

  const path = readRequiredString(input, 'path');
  if (!path.ok) {
    return path;
  }

  const depth = readOptionalInteger(input, 'depth', 1, 1, MAX_SCHEMA_LIST_DEPTH);
  if (!depth.ok) {
    return depth;
  }

  const limit = readOptionalInteger(input, 'limit', DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  if (!limit.ok) {
    return limit;
  }

  return {
    ok: true,
    value: {
      path: path.value,
      depth: depth.value,
      limit: limit.value,
    },
  };
}

function validateReadInput(input: unknown): ValidationResult<{ path: string; offset: number; maxBytes: number }> {
  if (!isRecord(input)) {
    return { ok: false, message: 'input must be an object' };
  }

  const path = readRequiredString(input, 'path');
  if (!path.ok) {
    return path;
  }

  const offset = readOptionalInteger(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (!offset.ok) {
    return offset;
  }

  const maxBytes = readOptionalInteger(input, 'maxBytes', DEFAULT_READ_MAX_BYTES, 1, MAX_READ_BYTES);
  if (!maxBytes.ok) {
    return maxBytes;
  }

  return { ok: true, value: { path: path.value, offset: offset.value, maxBytes: maxBytes.value } };
}

function readScore(result: ReaderSearchResult): number | undefined {
  const rawScore = result.properties?.score;
  if (rawScore === undefined) {
    return undefined;
  }

  const score = Number(rawScore);
  return Number.isFinite(score) ? score : undefined;
}

function mapSearchResult(result: ReaderSearchResult): WorkspaceSearchOutput {
  const score = readScore(result);
  const preview = result.snippet ?? result.title;
  return {
    path: result.path,
    provider: result.provider,
    ...(score !== undefined ? { score } : {}),
    ...(preview ? { preview } : {}),
  };
}

function listOutputEntry(entry: ReaderListEntry): Record<string, unknown> {
  return {
    path: entry.path,
    type: entry.type,
    provider: entry.provider,
    ...(entry.title ? { title: entry.title } : {}),
    revision: entry.revision,
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    ...(entry.size !== undefined ? { size: entry.size } : {}),
  };
}

function knownToolName(name: string): boolean {
  return WORKSPACE_TOOLS.some((tool) => tool.name === name);
}

export function createWorkspaceToolRegistry(
  options: WorkspaceToolRegistryOptions,
): HarnessToolRegistry {
  const defaultSearchLimit = normalizeOption(
    options.defaultSearchLimit,
    DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT,
  );
  const maxListDepth = normalizeOption(
    options.maxListDepth,
    DEFAULT_MAX_LIST_DEPTH,
    MAX_SCHEMA_LIST_DEPTH,
  );

  return {
    async listAvailable(input) {
      if (!options.reader.isEnabled()) {
        return [];
      }

      if (!input.allowedToolNames || input.allowedToolNames.length === 0) {
        return [...WORKSPACE_TOOLS];
      }

      const allowedToolNames = new Set(input.allowedToolNames);
      return WORKSPACE_TOOLS.filter((tool) => allowedToolNames.has(tool.name));
    },

    async execute(call) {
      if (!knownToolName(call.name)) {
        return unknownToolResult(call);
      }

      if (!options.reader.isEnabled()) {
        return workspaceUnavailableResult(call);
      }

      try {
        if (call.name === 'workspace_search') {
          const validation = validateSearchInput(call.input, defaultSearchLimit);
          if (!validation.ok) {
            return invalidInputResult(call, validation.message);
          }

          const results = await options.reader.searchFiles(
            validation.value.query,
            validation.value.provider,
            validation.value.limit,
          );
          return successResult(
            call,
            stringifyArrayOutput(results.map((result) => mapSearchResult(result))),
          );
        }

        if (call.name === 'workspace_list') {
          const validation = validateListInput(call.input);
          if (!validation.ok) {
            return invalidInputResult(call, validation.message);
          }

          const entries = await options.reader.listTree(
            validation.value.path,
            Math.min(validation.value.depth, maxListDepth),
            validation.value.limit,
          );
          return successResult(
            call,
            stringifyArrayOutput(entries.map((entry) => listOutputEntry(entry))),
          );
        }

        const validation = validateReadInput(call.input);
        if (!validation.ok) {
          return invalidInputResult(call, validation.message);
        }

        const content = await options.reader.readFile(validation.value.path);
        if (content === null) {
          return notFoundResult(call, validation.value.path);
        }

        return successResult(call, stringifyReadOutput(content, validation.value.offset, validation.value.maxBytes));
      } catch (error) {
        return thrownErrorResult(call, error);
      }
    },
  };
}
