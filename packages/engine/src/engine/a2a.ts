import { and, eq, sql } from 'drizzle-orm';
import {
  A2aAgentCardSchema,
  A2aMessageSchema,
  A2aPartSchema,
  A2aResponseSchema,
  A2aTaskSchema,
  A2aTaskStateSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
  type A2aAgentCard,
  type A2aJsonRpcRequest,
  type A2aJsonRpcResponse,
  type A2aMessage,
  type A2aPart,
  type A2aResponse,
  type A2aTask,
  type A2aTaskState,
} from '@relaycast/a2a';
import { z } from 'zod';
import type { FileAttachment } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import { a2aAgents, agents } from '../db/schema.js';
import { registerAgent, getAgentByName, updateAgent } from './agent.js';
import { rotateAgentToken } from './tokenRotate.js';
import { createAndRunCertification } from './certify.js';
import { isSafeExternalUrl } from '../lib/ssrf.js';
import { randomUuid, sha256Hex } from '../lib/crypto.js';

type Db = ReturnType<typeof getDb>;

const RETRY_DELAYS_MS = [250, 750] as const;
const DEFAULT_WEBHOOK_BASE_PATH = '/a2a/webhook';

const RelayFileAttachmentSchema = z.object({
  file_id: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
});

const RelayDMSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  text: z.string(),
  created_at: z.string().optional(),
  thread_id: z.string().nullable().optional(),
  attachments: z.array(RelayFileAttachmentSchema).optional(),
});

export {
  A2aAgentCardSchema,
  A2aMessageSchema,
  A2aPartSchema,
  A2aResponseSchema,
  A2aTaskSchema,
  A2aTaskStateSchema,
  JsonRpcRequestSchema,
  JsonRpcResponseSchema,
};

export type {
  A2aAgentCard,
  A2aJsonRpcRequest,
  A2aJsonRpcResponse,
  A2aMessage,
  A2aPart,
  A2aResponse,
  A2aTask,
  A2aTaskState,
};

export type RelayDM = z.infer<typeof RelayDMSchema>;

export interface RegisterA2aAgentInput {
  agentCardUrl?: string;
  agentCard?: A2aAgentCard;
  authScheme?: 'bearer' | 'api_key' | 'none';
  authCredential?: string;
}

export interface RegisterA2aAgentResult {
  relayName: string;
  relayToken: string;
  webhookUrl: string;
  certification: 'level_0' | 'level_1';
}

export interface A2aAgentRecord {
  id: string;
  workspace_id: string;
  relay_agent_id: string;
  relay_name: string;
  relay_status: string;
  relay_persona: string | null;
  relay_metadata: Record<string, unknown> | null;
  agent_card: A2aAgentCard;
  external_url: string;
  auth_scheme: string | null;
  auth_credential: string | null;
  status: string;
  messages_sent: number;
  messages_recv: number;
  last_health: string | null;
  health_failures: number;
  created_at: string;
  updated_at: string;
}

function ensureString(value: string | undefined, message: string): string {
  if (!value) {
    const err = new Error(message);
    Object.assign(err, { code: 'invalid_request', status: 400 });
    throw err;
  }
  return value;
}

function normalizeBaseUrl(urlOrPath: string): string {
  const url = new URL(urlOrPath);
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

function wellKnownAgentCardUrl(agentUrl: string): string {
  const base = new URL(agentUrl);
  return `${base.origin}/.well-known/agent-card.json`;
}

async function deriveRelayName(card: A2aAgentCard): Promise<string> {
  const slug = card.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
  const suffix = (await sha256Hex(card.url)).slice(0, 8);
  return `ext-${slug}-${suffix}`;
}

function buildWebhookUrl(workspaceId: string, relayName: string): string {
  return `${DEFAULT_WEBHOOK_BASE_PATH}/${workspaceId}/${relayName}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAgentCard(agentCardUrl: string): Promise<A2aAgentCard> {
  if (!isSafeExternalUrl(agentCardUrl)) {
    const err = new Error(`Refusing to fetch agent card from non-public URL: ${agentCardUrl}`);
    Object.assign(err, { code: 'a2a_agent_url_forbidden', status: 400 });
    throw err;
  }
  const response = await globalThis.fetch(agentCardUrl, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const err = new Error(`Failed to fetch agent card from ${agentCardUrl}: ${response.status}`);
    Object.assign(err, { code: 'a2a_agent_card_fetch_failed', status: 502 });
    throw err;
  }

  const payload = await response.json();
  return A2aAgentCardSchema.parse(payload);
}

function extractTextFromParts(parts: A2aPart[]): string {
  return parts
    .map((part) => {
      if (part.kind === 'text') return part.text;
      if (part.kind === 'file') return `[file] ${part.file.name}`;
      return JSON.stringify(part.data);
    })
    .join('\n')
    .trim();
}

function extractAttachmentsFromParts(parts: A2aPart[]): FileAttachment[] {
  const attachments: FileAttachment[] = [];

  for (const part of parts) {
    if (part.kind === 'file') {
      attachments.push({
        file_id: part.file.uri ?? randomUuid(),
        filename: part.file.name,
        content_type: part.file.mime_type ?? 'application/octet-stream',
        size_bytes: part.file.bytes ?? 0,
      });
      continue;
    }

    if (part.kind === 'data' && typeof part.data.file_id === 'string' && typeof part.data.filename === 'string') {
      attachments.push({
        file_id: part.data.file_id,
        filename: part.data.filename,
        content_type:
          typeof part.data.content_type === 'string'
            ? part.data.content_type
            : 'application/octet-stream',
        size_bytes:
          typeof part.data.size_bytes === 'number'
            ? part.data.size_bytes
            : 0,
      });
    }
  }

  return attachments;
}

function buildAuthHeaders(auth?: {
  scheme?: 'bearer' | 'api_key' | 'none' | string | null;
  credential?: string | null;
}): HeadersInit {
  if (!auth || auth.scheme === 'none' || !auth.credential) return {};
  if (auth.scheme === 'bearer') return { authorization: `Bearer ${auth.credential}` };
  if (auth.scheme === 'api_key') return { 'x-api-key': auth.credential };
  return {};
}

function formatDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function formatA2aRecord(row: {
  id: string;
  workspaceId: string;
  relayAgentId: string;
  agentCard: unknown;
  externalUrl: string;
  authScheme: string | null;
  authCredential: string | null;
  status: string;
  messagesSent: number;
  messagesRecv: number;
  lastHealth: Date | null;
  healthFailures: number;
  createdAt: Date;
  updatedAt: Date;
  relayName: string;
  relayStatus: string;
  relayPersona: string | null;
  relayMetadata: unknown;
}): A2aAgentRecord {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    relay_agent_id: row.relayAgentId,
    relay_name: row.relayName,
    relay_status: row.relayStatus,
    relay_persona: row.relayPersona,
    relay_metadata: (row.relayMetadata as Record<string, unknown> | null) ?? null,
    agent_card: A2aAgentCardSchema.parse(row.agentCard),
    external_url: row.externalUrl,
    auth_scheme: row.authScheme,
    auth_credential: row.authCredential,
    status: row.status,
    messages_sent: row.messagesSent,
    messages_recv: row.messagesRecv,
    last_health: formatDate(row.lastHealth),
    health_failures: row.healthFailures,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function registerA2aAgent(
  db: Db,
  workspaceId: string,
  input: RegisterA2aAgentInput,
): Promise<RegisterA2aAgentResult> {
  const resolvedCard = input.agentCard
    ?? await fetchAgentCard(ensureString(input.agentCardUrl, 'agent_card_url is required when agent_card is not provided'));
  const agentCard = A2aAgentCardSchema.parse(resolvedCard);
  const externalUrl = normalizeBaseUrl(agentCard.url);
  const relayName = await deriveRelayName(agentCard);

  const [existing] = await db
    .select({ id: a2aAgents.id })
    .from(a2aAgents)
    .innerJoin(agents, eq(a2aAgents.relayAgentId, agents.id))
    .where(and(eq(a2aAgents.workspaceId, workspaceId), eq(agents.name, relayName)));

  if (existing) {
    const err = new Error(`A2A agent "${relayName}" already exists in this workspace`);
    Object.assign(err, { code: 'a2a_agent_already_exists', status: 409 });
    throw err;
  }

  const proxyMetadata = {
    a2a: true,
    a2a_external_url: externalUrl,
    a2a_skills: agentCard.skills,
    a2a_active: true,
  };

  // A prior removeA2aAgent soft-removes the A2A agent: it deletes the a2a_agents
  // row but keeps the relay proxy agent (marked offline, a2a_active:false) to
  // preserve history. On re-registration the existence check above passes (no
  // a2a row), so reuse + reactivate that leftover proxy rather than inserting a
  // duplicate name and tripping the agents (workspace, name) unique constraint.
  const existingProxy = await getAgentByName(db, workspaceId, relayName);
  let relayAgentId: string;
  let relayToken: string;
  if (existingProxy) {
    const meta = (existingProxy.metadata ?? {}) as Record<string, unknown>;
    // Only an actual A2A proxy may be reused — require the a2a marker, not just
    // type 'external', so an unrelated agent can never be hijacked by name.
    const isA2aProxy = existingProxy.type === 'external' && meta.a2a === true;
    if (!isA2aProxy) {
      const err = new Error(`Agent "${relayName}" already exists in this workspace`);
      Object.assign(err, { code: 'agent_already_exists', status: 409 });
      throw err;
    }
    await updateAgent(db, workspaceId, relayName, { status: 'active', metadata: proxyMetadata });
    const rotated = await rotateAgentToken(db, workspaceId, relayName);
    relayAgentId = existingProxy.id;
    relayToken = rotated.token;
  } else {
    const provisioned = await registerAgent(db, workspaceId, {
      name: relayName,
      type: 'external',
      persona: `External A2A agent proxy for ${agentCard.name}`,
      metadata: proxyMetadata,
    });
    relayAgentId = provisioned.id;
    relayToken = provisioned.token;
  }

  const healthOk = await healthCheckAgent(externalUrl);
  let certification: 'level_0' | 'level_1' = healthOk ? 'level_1' : 'level_0';

  await db.insert(a2aAgents).values({
    id: `a2a_${randomUuid()}`,
    workspaceId,
    relayAgentId,
    agentCard,
    externalUrl,
    authScheme: input.authScheme ?? null,
    authCredential: input.authCredential ?? null,
    status: 'active',
    lastHealth: healthOk ? new Date() : null,
    healthFailures: healthOk ? 0 : 1,
    messagesSent: 0,
    messagesRecv: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    const certificationRun = await createAndRunCertification(db, workspaceId, {
      agentUrl: externalUrl,
      level: 1,
      source: 'registration',
    });
    certification = certificationRun.passed ? 'level_1' : 'level_0';
  } catch {
    certification = healthOk ? 'level_1' : 'level_0';
  }

  return {
    relayName,
    relayToken,
    webhookUrl: buildWebhookUrl(workspaceId, relayName),
    certification,
  };
}

export async function listA2aAgents(db: Db, workspaceId: string): Promise<A2aAgentRecord[]> {
  const rows = await db
    .select({
      id: a2aAgents.id,
      workspaceId: a2aAgents.workspaceId,
      relayAgentId: a2aAgents.relayAgentId,
      agentCard: a2aAgents.agentCard,
      externalUrl: a2aAgents.externalUrl,
      authScheme: a2aAgents.authScheme,
      authCredential: a2aAgents.authCredential,
      status: a2aAgents.status,
      messagesSent: a2aAgents.messagesSent,
      messagesRecv: a2aAgents.messagesRecv,
      lastHealth: a2aAgents.lastHealth,
      healthFailures: a2aAgents.healthFailures,
      createdAt: a2aAgents.createdAt,
      updatedAt: a2aAgents.updatedAt,
      relayName: agents.name,
      relayStatus: agents.status,
      relayPersona: agents.persona,
      relayMetadata: agents.metadata,
    })
    .from(a2aAgents)
    .innerJoin(agents, eq(a2aAgents.relayAgentId, agents.id))
    .where(eq(a2aAgents.workspaceId, workspaceId));

  return rows.map(formatA2aRecord);
}

export async function getA2aAgentByRelayName(
  db: Db,
  workspaceId: string,
  relayName: string,
): Promise<A2aAgentRecord | null> {
  const [row] = await db
    .select({
      id: a2aAgents.id,
      workspaceId: a2aAgents.workspaceId,
      relayAgentId: a2aAgents.relayAgentId,
      agentCard: a2aAgents.agentCard,
      externalUrl: a2aAgents.externalUrl,
      authScheme: a2aAgents.authScheme,
      authCredential: a2aAgents.authCredential,
      status: a2aAgents.status,
      messagesSent: a2aAgents.messagesSent,
      messagesRecv: a2aAgents.messagesRecv,
      lastHealth: a2aAgents.lastHealth,
      healthFailures: a2aAgents.healthFailures,
      createdAt: a2aAgents.createdAt,
      updatedAt: a2aAgents.updatedAt,
      relayName: agents.name,
      relayStatus: agents.status,
      relayPersona: agents.persona,
      relayMetadata: agents.metadata,
    })
    .from(a2aAgents)
    .innerJoin(agents, eq(a2aAgents.relayAgentId, agents.id))
    .where(and(eq(a2aAgents.workspaceId, workspaceId), eq(agents.name, relayName)));

  return row ? formatA2aRecord(row) : null;
}

export async function removeA2aAgent(db: Db, workspaceId: string, relayName: string): Promise<boolean> {
  const agentRecord = await getA2aAgentByRelayName(db, workspaceId, relayName);
  if (!agentRecord) return false;

  await db.delete(a2aAgents).where(eq(a2aAgents.id, agentRecord.id));
  await db
    .update(agents)
    .set({
      status: 'offline',
      metadata: {
        ...(agentRecord.relay_metadata ?? {}),
        a2a: true,
        a2a_active: false,
      },
    })
    .where(eq(agents.id, agentRecord.relay_agent_id));

  return true;
}

export function translateRelayToA2a(message: RelayDM): A2aJsonRpcRequest {
  const relay = RelayDMSchema.parse(message);
  const parts: A2aPart[] = [{ kind: 'text', text: relay.text }];

  for (const attachment of relay.attachments ?? []) {
    parts.push({
      kind: 'file',
      file: {
        name: attachment.filename,
        mime_type: attachment.content_type,
        uri: attachment.file_id,
        bytes: attachment.size_bytes,
      },
    });
  }

  return {
    jsonrpc: '2.0',
    id: relay.id,
    method: 'message/send',
    params: {
      message: {
        message_id: relay.id,
        role: 'user',
        context_id: relay.thread_id ?? undefined,
        parts,
      },
    },
  };
}

export function translateA2aToRelay(jsonRpc: A2aJsonRpcRequest | A2aJsonRpcResponse): RelayDM {
  const parsedRequest = JsonRpcRequestSchema.safeParse(jsonRpc);

  if (parsedRequest.success && parsedRequest.data.params?.message) {
    const message = parsedRequest.data.params.message;
    return {
      id: String(parsedRequest.data.id ?? message.message_id),
      agent_id: 'external',
      agent_name: 'external',
      text: extractTextFromParts(message.parts),
      thread_id: message.context_id ?? null,
      attachments: extractAttachmentsFromParts(message.parts),
    };
  }

  const parsedResponse = JsonRpcResponseSchema.parse(jsonRpc);
  const task = parsedResponse.result?.task;
  const responseMessage = parsedResponse.result?.message ?? task?.history?.at(-1);
  const parts = responseMessage?.parts ?? task?.artifacts?.flatMap((artifact) => artifact.parts) ?? [];

  return {
    id: String(parsedResponse.id ?? task?.id ?? randomUuid()),
    agent_id: task?.id ?? 'external',
    agent_name: 'external',
    text: parts.length > 0 ? extractTextFromParts(parts) : task?.status.message ?? '',
    thread_id: responseMessage?.context_id ?? task?.context_id ?? null,
    attachments: extractAttachmentsFromParts(parts),
  };
}

export async function sendToExternalAgent(
  agentUrl: string,
  jsonRpcPayload: A2aJsonRpcRequest,
  auth?: { scheme?: 'bearer' | 'api_key' | 'none' | string | null; credential?: string | null },
): Promise<A2aResponse> {
  const request = JsonRpcRequestSchema.parse(jsonRpcPayload);
  const targetUrl = normalizeBaseUrl(agentUrl);

  if (!isSafeExternalUrl(targetUrl)) {
    const err = new Error(`Refusing to send to non-public A2A URL: ${targetUrl}`);
    Object.assign(err, { code: 'a2a_agent_url_forbidden', status: 400 });
    throw err;
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await globalThis.fetch(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...buildAuthHeaders(auth),
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const err = new Error(`A2A upstream returned ${response.status}`);
        Object.assign(err, {
          code: response.status >= 500 ? 'a2a_upstream_unavailable' : 'a2a_upstream_rejected',
          status: response.status >= 500 ? 502 : response.status,
          retryable: response.status >= 500,
        });
        throw err;
      }

      const payload = await response.json();
      const parsedResponse = JsonRpcResponseSchema.parse(payload);

      if (parsedResponse.error) {
        const err = new Error(parsedResponse.error.message);
        Object.assign(err, {
          code: 'a2a_jsonrpc_error',
          status: 502,
          data: parsedResponse.error,
          retryable: false,
        });
        throw err;
      }

      return {
        response: parsedResponse,
        task: parsedResponse.result?.task,
        message: parsedResponse.result?.message,
      };
    } catch (error) {
      lastError = error;
      // Only retry errors explicitly marked retryable (5xx, network).
      // ZodErrors, JSON-RPC errors, and 4xx responses are not retryable.
      const retryable = error instanceof Error && (error as Error & { retryable?: boolean }).retryable === true;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to send request to external A2A agent');
}

export function mapTaskState(a2aState: A2aTaskState): string {
  switch (a2aState) {
    case 'submitted':
      return 'queued';
    case 'working':
      return 'in_progress';
    case 'input-required':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'unknown':
    default:
      return 'unknown';
  }
}

export function mapRelayTaskState(relayState: string | null | undefined): A2aTaskState {
  switch (relayState) {
    case 'queued':
      return 'submitted';
    case 'in_progress':
    case 'online':
      return 'working';
    case 'waiting':
      return 'input-required';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

export async function healthCheckAgent(agentUrl: string): Promise<boolean> {
  try {
    const response = await globalThis.fetch(wellKnownAgentCardUrl(agentUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function incrementA2aMessagesSent(db: Db, id: string): Promise<void> {
  await db
    .update(a2aAgents)
    .set({
      messagesSent: sql`${a2aAgents.messagesSent} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(a2aAgents.id, id));
}

export async function incrementA2aMessagesReceived(db: Db, id: string): Promise<void> {
  await db
    .update(a2aAgents)
    .set({
      messagesRecv: sql`${a2aAgents.messagesRecv} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(a2aAgents.id, id));
}

export async function getWorkspaceAgentCard(
  db: Db,
  workspaceId: string,
  workspaceName: string,
  baseUrl: string,
): Promise<A2aAgentCard> {
  const workspaceAgents = await db
    .select({
      name: agents.name,
      persona: agents.persona,
      type: agents.type,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));

  const skills = workspaceAgents.map((agent) => ({
    id: agent.name,
    name: agent.name,
    description: agent.persona ?? `${agent.type} agent in ${workspaceName}`,
    tags: ['relaycast', agent.type],
  }));

  return {
    name: workspaceName,
    description: `Relaycast workspace card for ${workspaceName}`,
    url: `${baseUrl}/a2a/rpc`,
    version: '1.0.0',
    skills: skills.length > 0 ? skills : [{
      id: workspaceName,
      name: workspaceName,
      description: `Relaycast workspace ${workspaceName}`,
      tags: ['relaycast', 'workspace'],
    }],
    provider: {
      organization: 'Relaycast',
      workspace_id: workspaceId,
      workspace_name: workspaceName,
    },
    capabilities: {
      methods: ['message/send', 'message/stream', 'task/get', 'task/cancel'],
    },
    default_input_modes: ['text/plain', 'application/json'],
    default_output_modes: ['text/plain', 'application/json'],
    documentation_url: 'https://github.com/AgentWorkforce/relaycast',
  };
}

export function jsonRpcSuccess(
  id: string | number | undefined,
  result: Record<string, unknown>,
): A2aJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function jsonRpcError(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): A2aJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
