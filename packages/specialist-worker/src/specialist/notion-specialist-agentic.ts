import * as specialistExports from '@agent-assistant/specialists';
import {
  createOpenRouterModelAdapter,
  type HarnessModelAdapter,
  type HarnessToolAvailabilityInput,
  type HarnessToolCall,
  type HarnessToolDefinition,
  type HarnessToolExecutionContext,
  type HarnessToolRegistry,
  type HarnessToolResult,
} from '@agent-assistant/harness';

import type { RelayFileClient } from '@relayfile/sdk';

import { OPENROUTER_MODELS } from './openrouter.js';
import { createRelayFileVfsProvider } from './relayfile-vfs-provider.js';
import { RelayFileWorkspaceReader } from './relayfile-workspace-reader.js';
import { createWorkspaceToolRegistry } from './workspace-tool-registry.js';

import type { A2AAgentCard } from './agent-card.js';
import {
  createAgenticSpecialist,
} from './agentic-specialist.js';
import { composeToolRegistries } from './tool-adapters.js';
import { wrapToolRegistryWithTrace } from './tool-registry-trace.js';

const SPECIALIST_AGENT_NAME = 'sage-notion-specialist';
const SPECIALIST_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 45_000;
const NOTION_ENUMERATE_TOOL_NAME = 'notion_enumerate';

const NOTION_SPECIALIST_PROMPT: string = `You are the Notion specialist for Sage.
Your job is to turn Sage delegation requests into verified Notion findings with concrete evidence from tools.
You do not act as a general assistant; you are a narrow Notion researcher for pages, databases, comments, titles, parent-child structure, and recent editing activity.

Tool inventory and when to use each:
- notion_enumerate: Prefer this for structured Notion lists with filters such as page title, parent page/database, entity type, or last editor. notion_enumerate returns authoritative evidence from the deterministic Notion librarian; build findings directly from the returned evidence array.
- workspace_search: Use this for keyword-style discovery across synced Notion content when the exact page or database is unclear.
- workspace_list: Use this to inspect available Notion directories, page trees, and nearby VFS paths when you need orientation before reading.
- workspace_read: Use this to read specific page bodies, metadata, or comments during a targeted follow-up investigation. Do not use workspace_read to enrich notion_enumerate output.

Tool-first discipline:
- Never answer from memory; always call a tool.
- For filtered list requests, notion_enumerate is the primary tool and its evidence is the answer.
- Do not invent Notion page titles, IDs, database names, editors, timestamps, or URLs.
- If tool data is incomplete or ambiguous, return status "partial" and state what is missing.
- Treat "my", "mine", and "edited by me" as requiring tool-backed identity or metadata rather than assumption.

Output contract:
- Final answer MUST be a JSON-fenced block matching SpecialistFindings, followed by no prose:
\`\`\`json
{
  "status": "complete" | "partial",
  "summary": "<2-4 sentence synthesis>",
  "findings": [
    { "title": "<short title>", "body": "<specific evidence>", "url": "<optional link>", "metadata": {"id": "...", "kind": "..."} }
  ],
  "confidence": 0.0-1.0
}
\`\`\`
- The JSON block is the specialist's whole answer; Sage's main agent parses it.
- Use url when a canonical Notion link is available; otherwise omit it or leave it empty.
- Do not include Markdown or commentary outside the JSON fence.`;

type SpecialistStatus = 'complete' | 'partial' | 'failed';
type NotionEntityType = 'page' | 'database' | 'comment';

type NotionEnumerateInput = {
  query: string;
  filters?: {
    parentId?: string;
    title?: string;
    type?: NotionEntityType;
    lastEditedBy?: string;
  };
};

type NotionFallbackRequest = {
  instruction: string;
  text: string;
  filters: Record<string, string[]>;
  types: NotionEntityType[];
};

export type NotionLibrarianApiFallback =
  | ((request: NotionFallbackRequest) => Promise<readonly unknown[]>)
  | {
      list?(request: NotionFallbackRequest): Promise<readonly unknown[]>;
      search?(request: NotionFallbackRequest): Promise<readonly unknown[]>;
    };

export interface NotionQueryFilterSet {
  parentId?: string[];
  title?: string[];
  type?: NotionEntityType[];
  lastEditedBy?: string[];
  [filter: string]: string[] | undefined;
}

export interface NotionEnumerationParams {
  capability: 'notion.enumerate';
  query?: string;
  filters?: NotionQueryFilterSet;
  cursor?: string;
  limit?: number;
}

export interface NotionAgenticSpecialist {
  card: A2AAgentCard;
  transport: {
    delegate(request: {
      requestId: string;
      workspaceId?: string;
      capability: NotionEnumerationParams['capability'];
      params: NotionEnumerationParams;
      timeoutMs?: number;
      metadata?: Record<string, unknown>;
    }): Promise<{
      requestId: string;
      capability: NotionEnumerationParams['capability'];
      status: SpecialistStatus;
      summary: string;
      findings: Array<{
        title: string;
        body?: string;
        url?: string;
        metadata?: Record<string, unknown>;
      }>;
      confidence?: number;
      metadata?: Record<string, unknown>;
    }>;
  };
}

type NotionLibrarian = {
  handler: {
    execute(instruction: string, context?: unknown): Promise<unknown>;
  };
};

type NotionSpecialistExports = typeof specialistExports & {
  createNotionLibrarian?: (options: {
    vfs: ReturnType<typeof createRelayFileVfsProvider>;
    apiFallback?: NotionLibrarianApiFallback;
  }) => NotionLibrarian;
};

const NOTION_ENUMERATE_INPUT_SCHEMA = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string' },
    filters: {
      type: 'object',
      properties: {
        parentId: { type: 'string' },
        title: { type: 'string' },
        type: { type: 'string', enum: ['page', 'database', 'comment'] },
        lastEditedBy: { type: 'string' },
      },
    },
  },
} satisfies Record<string, unknown>;

const NOTION_ENUMERATE_TOOL: HarnessToolDefinition = {
  name: NOTION_ENUMERATE_TOOL_NAME,
  description:
    'Enumerate Notion pages, databases, and comments from the deterministic Notion librarian.',
  inputSchema: NOTION_ENUMERATE_INPUT_SCHEMA,
};

export interface NotionAgenticSpecialistOptions {
  relayFile: RelayFileClient;
  workspaceId: string;
  /** OpenRouter API key. */
  apiKey: string;
  /** Optional live Notion API fallback. Omit or pass null for VFS-only operation. */
  apiFallback?: NotionLibrarianApiFallback | null;
  /** Defaults to OPENROUTER_MODELS.heavy. */
  model?: string;
  /** Injectable fetch for tests and alternate runtimes. */
  fetchImpl?: typeof fetch;
  /** Defaults to 45 seconds. */
  timeoutMs?: number;
  /** Forward the `DEBUG_SPECIALIST` binding for diagnostic logging. */
  debugSpecialist?: string;
}

export function buildNotionSpecialistCard(): A2AAgentCard {
  return {
    name: SPECIALIST_AGENT_NAME,
    description:
      'Notion specialist for Sage. Enumerates pages, databases, comments, and synthesizes workspace knowledge.',
    version: SPECIALIST_VERSION,
    url: '',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      {
        id: 'notion.enumerate',
        name: 'Notion Enumeration',
        description:
          'Enumerate Notion entities matching a query and return structured findings.',
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidInputResult(call: HarnessToolCall, message: string): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: 'error',
    error: {
      code: 'invalid_input',
      message,
      retryable: false,
    },
  };
}

function unknownToolResult(call: HarnessToolCall): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: 'error',
    error: {
      code: 'unknown_tool',
      message: `Unknown tool: ${call.name}`,
      retryable: false,
    },
  };
}

function specialistBackendFailedResult(
  call: HarnessToolCall,
  message: string,
): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: 'error',
    error: {
      code: 'specialist_backend_failed',
      message,
      retryable: false,
    },
  };
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const value = input[key];
  if (typeof value !== 'string') {
    return { ok: false, message: `input.${key} must be a string` };
  }
  return { ok: true, value };
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const value = input[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: `input.${key} must be a string when provided` };
  }
  return { ok: true, value };
}

function validateNotionEnumerateFilters(
  value: unknown,
): { ok: true; value: NotionEnumerateInput['filters'] } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: 'input.filters must be an object when provided' };
  }

  const parentId = readOptionalString(value, 'parentId');
  if (!parentId.ok) {
    return parentId;
  }
  const title = readOptionalString(value, 'title');
  if (!title.ok) {
    return title;
  }
  const lastEditedBy = readOptionalString(value, 'lastEditedBy');
  if (!lastEditedBy.ok) {
    return lastEditedBy;
  }

  const typeValue = value.type;
  if (
    typeValue !== undefined &&
    typeValue !== 'page' &&
    typeValue !== 'database' &&
    typeValue !== 'comment'
  ) {
    return {
      ok: false,
      message: 'input.filters.type must be one of: page, database, comment',
    };
  }

  const filters: NonNullable<NotionEnumerateInput['filters']> = {};
  if (parentId.value !== undefined) {
    filters.parentId = parentId.value;
  }
  if (title.value !== undefined) {
    filters.title = title.value;
  }
  if (typeValue !== undefined) {
    filters.type = typeValue;
  }
  if (lastEditedBy.value !== undefined) {
    filters.lastEditedBy = lastEditedBy.value;
  }

  return {
    ok: true,
    value: Object.keys(filters).length > 0 ? filters : undefined,
  };
}

function validateNotionEnumerateInput(
  input: unknown,
): { ok: true; value: NotionEnumerateInput } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: 'input must be an object' };
  }

  const query = readRequiredString(input, 'query');
  if (!query.ok) {
    return query;
  }

  const filters = validateNotionEnumerateFilters(input.filters);
  if (!filters.ok) {
    return filters;
  }

  return {
    ok: true,
    value: {
      query: query.value,
      ...(filters.value ? { filters: filters.value } : {}),
    },
  };
}

function addFilterToken(parts: string[], key: string, value: string | undefined): void {
  if (value !== undefined) {
    parts.push(`${key}:${value.trim()}`);
  }
}

function buildNotionEnumerateInstruction(input: NotionEnumerateInput): string {
  const parts = input.query.trim() ? [input.query.trim()] : [];
  addFilterToken(parts, 'parentId', input.filters?.parentId);
  addFilterToken(parts, 'title', input.filters?.title);
  addFilterToken(parts, 'type', input.filters?.type);
  addFilterToken(parts, 'lastEditedBy', input.filters?.lastEditedBy);
  return parts.join(' ').trim();
}

function isSpecialistStatus(value: unknown): value is SpecialistStatus {
  return value === 'complete' || value === 'partial' || value === 'failed';
}

function statusFromResult(result: unknown): SpecialistStatus | null {
  if (!isRecord(result) || !isSpecialistStatus(result.status)) {
    return null;
  }
  return result.status;
}

function summaryFromFindings(findings: unknown): string | null {
  if (isRecord(findings) && typeof findings.summary === 'string') {
    return findings.summary;
  }
  return null;
}

function evidenceFromFindings(findings: unknown): unknown {
  if (isRecord(findings)) {
    if ('evidence' in findings) {
      return findings.evidence;
    }
    if ('findings' in findings) {
      return findings.findings;
    }
  }
  return findings;
}

function isEmptyEnumerationResult(result: unknown, findings: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.metadata)) {
    return false;
  }
  if (result.metadata.resultCount !== 0 || 'errors' in result.metadata) {
    return false;
  }

  const evidence = evidenceFromFindings(findings);
  return Array.isArray(evidence) && evidence.length === 0;
}

function messageFromBackendFailure(result: unknown, findings: unknown): string {
  const summary = summaryFromFindings(findings);
  if (summary) {
    return summary;
  }
  if (isRecord(result) && typeof result.output === 'string' && result.output.length > 0) {
    return result.output;
  }
  return 'Specialist backend failed.';
}

function mapSpecialistResult(
  call: HarnessToolCall,
  result: unknown,
  findings: unknown,
): HarnessToolResult {
  const status = statusFromResult(result) ?? statusFromResult(findings);
  if (status === null) {
    return specialistBackendFailedResult(
      call,
      'Specialist backend returned an invalid status.',
    );
  }

  if (status === 'failed') {
    if (isEmptyEnumerationResult(result, findings)) {
      return {
        callId: call.id,
        toolName: call.name,
        status: 'success',
        output: JSON.stringify([], null, 2),
        structuredOutput: { findings: [], warning: 'empty' },
      };
    }

    return specialistBackendFailedResult(
      call,
      messageFromBackendFailure(result, findings),
    );
  }

  return {
    callId: call.id,
    toolName: call.name,
    status: 'success',
    output: JSON.stringify(evidenceFromFindings(findings), null, 2),
    structuredOutput:
      status === 'partial' ? { findings, warning: 'partial' } : { findings },
  };
}

function thrownBackendFailureResult(
  call: HarnessToolCall,
  error: unknown,
): HarnessToolResult {
  return specialistBackendFailedResult(
    call,
    error instanceof Error ? error.message : String(error),
  );
}

function availabilityInputFromContext(
  context: HarnessToolExecutionContext,
): HarnessToolAvailabilityInput {
  return {
    assistantId: context.assistantId,
    turnId: context.turnId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  };
}

function createNotionEnumerateTool(librarian: NotionLibrarian): HarnessToolRegistry {
  return {
    async listAvailable() {
      return [NOTION_ENUMERATE_TOOL];
    },

    async execute(call, context) {
      if (call.name !== NOTION_ENUMERATE_TOOL_NAME) {
        return unknownToolResult(call);
      }

      const validation = validateNotionEnumerateInput(call.input);
      if (!validation.ok) {
        return invalidInputResult(call, validation.message);
      }

      try {
        const result = await librarian.handler.execute(
          buildNotionEnumerateInstruction(validation.value),
          context,
        );
        return mapSpecialistResult(call, result, result);
      } catch (error) {
        return thrownBackendFailureResult(call, error);
      }
    },
  };
}

function getCreateNotionLibrarian(): NonNullable<
  NotionSpecialistExports['createNotionLibrarian']
> {
  const createNotionLibrarian = (specialistExports as NotionSpecialistExports)
    .createNotionLibrarian;
  if (typeof createNotionLibrarian !== 'function') {
    throw new Error(
      '@agent-assistant/specialists does not export createNotionLibrarian in this installation.',
    );
  }
  return createNotionLibrarian;
}

export function createNotionAgenticSpecialist(
  options: NotionAgenticSpecialistOptions,
): NotionAgenticSpecialist {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reader = new RelayFileWorkspaceReader({
    client: options.relayFile,
    workspaceId: options.workspaceId,
  });
  const vfs = createRelayFileVfsProvider(reader);
  const createNotionLibrarian = getCreateNotionLibrarian();
  const librarian = options.apiFallback
    ? createNotionLibrarian({
        vfs,
        apiFallback: options.apiFallback,
      })
    : createNotionLibrarian({ vfs });
  const workspaceTools = createWorkspaceToolRegistry({ reader });

  const tools = wrapToolRegistryWithTrace(
    composeToolRegistries(
      workspaceTools,
      createNotionEnumerateTool(librarian),
    ),
    SPECIALIST_AGENT_NAME,
  );

  const model: HarnessModelAdapter = createOpenRouterModelAdapter({
    apiKey: options.apiKey,
    model: options.model ?? OPENROUTER_MODELS.heavy,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });

  return createAgenticSpecialist({
    name: SPECIALIST_AGENT_NAME,
    version: SPECIALIST_VERSION,
    card: buildNotionSpecialistCard(),
    systemPrompt: NOTION_SPECIALIST_PROMPT,
    tools,
    model,
    timeoutMs,
    ...(options.debugSpecialist ? { debugSpecialist: options.debugSpecialist } : {}),
  }) as unknown as NotionAgenticSpecialist;
}
