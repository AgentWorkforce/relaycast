import { and, eq, or, gt, isNull, inArray, ne } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { channels, dmConversations, files as fileRows, messageAttachments, messages, observerTokens } from '../db/schema.js';
import type { ObserverTokenFilters } from '../db/schema.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { codedError } from '../lib/httpError.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;
export type ObserverToken = typeof observerTokens.$inferSelect;
const LAST_USED_DEBOUNCE_MS = 30_000;

export const OBSERVER_SCOPES = [
  'stream:read',
  'messages:read',
  'threads:read',
  'dms:read',
  'channels:read',
  'search:read',
  'agents:read',
  'nodes:read',
  'deliveries:read',
  'activity:read',
  'files:read',
  'reactions:read',
] as const;

export type ObserverScope = typeof OBSERVER_SCOPES[number];

export const OBSERVER_SCOPE_SET = new Set<string>(OBSERVER_SCOPES);

export interface PublicObserverToken {
  id: string;
  name: string;
  description: string | null;
  scopes: ObserverScope[];
  filters: ObserverTokenFilters;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  token?: string;
}

export interface CreateObserverTokenInput {
  name: string;
  description?: string | null;
  scopes: ObserverScope[];
  filters?: ObserverTokenFilters;
  expires_at?: string | null;
}

export interface UpdateObserverTokenInput {
  name?: string;
  description?: string | null;
  scopes?: ObserverScope[];
  filters?: ObserverTokenFilters;
  expires_at?: string | null;
}

function parseExpiresAt(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw codedError('expires_at must be an ISO-8601 timestamp', 'invalid_request', 400);
  }
  if (date.getTime() <= Date.now()) {
    throw codedError('expires_at must be in the future', 'invalid_request', 400);
  }
  return date;
}

export function normalizeObserverFilters(filters?: ObserverTokenFilters | null): ObserverTokenFilters {
  return {
    ...(filters?.channel_ids?.length ? { channel_ids: [...new Set(filters.channel_ids)] } : {}),
    ...(filters?.channel_names?.length ? { channel_names: [...new Set(filters.channel_names)] } : {}),
    include_dms: filters?.include_dms === true,
    ...(filters?.dm_conversation_ids?.length ? { dm_conversation_ids: [...new Set(filters.dm_conversation_ids)] } : {}),
    ...(filters?.agent_ids?.length ? { agent_ids: [...new Set(filters.agent_ids)] } : {}),
    ...(filters?.event_types?.length ? { event_types: [...new Set(filters.event_types)] } : {}),
    ...(filters?.created_after ? { created_after: filters.created_after } : {}),
  };
}

function normalizeScopes(scopes: string[]): ObserverScope[] {
  const unique = [...new Set(scopes)];
  const invalid = unique.filter((scope) => !OBSERVER_SCOPE_SET.has(scope));
  if (invalid.length > 0) {
    throw codedError(`Invalid observer scopes: ${invalid.join(', ')}`, 'invalid_request', 400);
  }
  if (unique.length === 0) {
    throw codedError('At least one observer scope is required', 'invalid_request', 400);
  }
  return unique as ObserverScope[];
}

function publicScopes(scopes: string[] | null | undefined): ObserverScope[] {
  const unique = [...new Set(scopes ?? [])];
  return unique.filter((scope): scope is ObserverScope => OBSERVER_SCOPE_SET.has(scope));
}

function publicObserverToken(row: ObserverToken, token?: string): PublicObserverToken {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scopes: publicScopes(row.scopes),
    filters: normalizeObserverFilters(row.filters),
    status: row.status,
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    ...(token ? { token } : {}),
  };
}

function isObserverTokenNameConflict(err: unknown): boolean {
  const candidate = err as { code?: string; message?: string };
  const message = candidate.message ?? '';
  return (
    candidate.code === 'SQLITE_CONSTRAINT'
    || candidate.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || message.includes('observer_tokens_workspace_name_unique')
    || message.includes('observer_tokens.workspace_id, observer_tokens.name')
  );
}

function observerTokenNameConflict(): never {
  throw codedError('Observer token name already exists in this workspace', 'observer_token_name_conflict', 409);
}

export async function createObserverToken(
  db: Db,
  workspaceId: string,
  input: CreateObserverTokenInput,
): Promise<PublicObserverToken> {
  const token = `ot_live_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);
  const expiresAt = parseExpiresAt(input.expires_at);
  const scopes = normalizeScopes(input.scopes);
  const filters = normalizeObserverFilters(input.filters);

  let created: ObserverToken | undefined;
  try {
    [created] = await db
      .insert(observerTokens)
      .values({
        id: `ot_${generateId()}`,
        workspaceId,
        name: input.name,
        description: input.description ?? null,
        tokenHash,
        scopes,
        filters,
        expiresAt,
        createdBy: workspaceId,
        createdByType: 'workspace',
      })
      .returning();
  } catch (err: unknown) {
    if (isObserverTokenNameConflict(err)) observerTokenNameConflict();
    throw err;
  }
  if (!created) {
    throw codedError('Failed to create observer token', 'internal_error', 500);
  }

  return publicObserverToken(created, token);
}

export async function listObserverTokens(db: Db, workspaceId: string): Promise<PublicObserverToken[]> {
  const rows = await db
    .select()
    .from(observerTokens)
    .where(eq(observerTokens.workspaceId, workspaceId));
  return rows.map((row) => publicObserverToken(row));
}

export async function getObserverToken(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<PublicObserverToken | null> {
  const [row] = await db
    .select()
    .from(observerTokens)
    .where(and(eq(observerTokens.workspaceId, workspaceId), eq(observerTokens.id, id)));
  return row ? publicObserverToken(row) : null;
}

export async function updateObserverToken(
  db: Db,
  workspaceId: string,
  id: string,
  input: UpdateObserverTokenInput,
): Promise<PublicObserverToken | null> {
  const update: Partial<typeof observerTokens.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined) update.description = input.description;
  if (input.scopes !== undefined) update.scopes = normalizeScopes(input.scopes);
  if (input.filters !== undefined) update.filters = normalizeObserverFilters(input.filters);
  if (input.expires_at !== undefined) update.expiresAt = parseExpiresAt(input.expires_at);

  let row: ObserverToken | undefined;
  try {
    [row] = await db
      .update(observerTokens)
      .set(update)
      .where(and(
        eq(observerTokens.workspaceId, workspaceId),
        eq(observerTokens.id, id),
        eq(observerTokens.status, 'active'),
      ))
      .returning();
  } catch (err: unknown) {
    if (isObserverTokenNameConflict(err)) observerTokenNameConflict();
    throw err;
  }

  return row ? publicObserverToken(row) : null;
}

export async function rotateObserverToken(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<PublicObserverToken | null> {
  const token = `ot_live_${randomHex(24)}`;
  const tokenHash = await sha256Hex(token);
  const [row] = await db
    .update(observerTokens)
    .set({ tokenHash, updatedAt: new Date(), lastUsedAt: null })
    .where(and(
      eq(observerTokens.workspaceId, workspaceId),
      eq(observerTokens.id, id),
      eq(observerTokens.status, 'active'),
    ))
    .returning();
  return row ? publicObserverToken(row, token) : null;
}

export async function revokeObserverToken(
  db: Db,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(observerTokens)
    .set({ status: 'revoked', revokedAt: now, updatedAt: now })
    .where(and(
      eq(observerTokens.workspaceId, workspaceId),
      eq(observerTokens.id, id),
      eq(observerTokens.status, 'active'),
    ))
    .returning({ id: observerTokens.id });
  return Boolean(row);
}

export async function getActiveObserverTokenByHash(
  db: Db,
  tokenHash: string,
): Promise<ObserverToken | null> {
  const now = new Date();
  const [row] = await db
    .select()
    .from(observerTokens)
    .where(and(
      eq(observerTokens.tokenHash, tokenHash),
      eq(observerTokens.status, 'active'),
      or(isNull(observerTokens.expiresAt), gt(observerTokens.expiresAt, now)),
    ));
  if (!row) return null;

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_DEBOUNCE_MS) {
    void (async () => {
      try {
        await db
          .update(observerTokens)
          .set({ lastUsedAt: now })
          .where(eq(observerTokens.id, row.id));
      } catch {
        // last_used_at is best-effort audit metadata; authentication should not fail
        // solely because a read replica or adapter rejects this update.
      }
    })();
  }
  return row;
}

export function hasObserverScope(observer: Pick<ObserverToken, 'scopes'>, scope: ObserverScope): boolean {
  return publicScopes(observer.scopes).includes(scope);
}

export function hasAnyObserverScope(observer: Pick<ObserverToken, 'scopes'>, scopes: ObserverScope[]): boolean {
  return scopes.some((scope) => hasObserverScope(observer, scope));
}

function filterList(values: string[] | undefined): Set<string> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

function hasChannelOrDmFilter(filters: ObserverTokenFilters): boolean {
  return Boolean(
    filters.channel_ids?.length
    || filters.channel_names?.length
    || filters.dm_conversation_ids?.length
    || filters.include_dms,
  );
}

export function observerAllowsChannel(
  observer: Pick<ObserverToken, 'filters'> | undefined,
  channel: { id?: string | null; name?: string | null; channel_type?: number | null; channelType?: number | null },
): boolean {
  if (!observer) return true;
  const channelType = channel.channel_type ?? channel.channelType;
  if (channelType != null && channelType !== 0) return false;
  const filters = normalizeObserverFilters(observer.filters);
  const ids = filterList(filters.channel_ids);
  const names = filterList(filters.channel_names);
  if (!ids && !names) return true;
  return Boolean((channel.id && ids?.has(channel.id)) || (channel.name && names?.has(channel.name)));
}

export function observerAllowsConversation(
  observer: Pick<ObserverToken, 'filters' | 'scopes'> | undefined,
  conversationId: string | null | undefined,
): boolean {
  if (!observer) return true;
  const filters = normalizeObserverFilters(observer.filters);
  if (!hasObserverScope(observer, 'dms:read')) return false;
  if (!filters.include_dms) return false;
  const ids = filterList(filters.dm_conversation_ids);
  if (!ids) return true;
  return Boolean(conversationId && ids.has(conversationId));
}

export function observerAllowsAgent(
  observer: Pick<ObserverToken, 'filters'> | undefined,
  agentId: string | null | undefined,
): boolean {
  if (!observer) return true;
  const ids = filterList(normalizeObserverFilters(observer.filters).agent_ids);
  if (!ids) return true;
  return Boolean(agentId && ids.has(agentId));
}

function timestampMillis(value: string | Date | number | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export function observerAllowsCreatedAt(
  observer: Pick<ObserverToken, 'filters'> | undefined,
  createdAt: string | Date | number | null | undefined,
): boolean {
  if (!observer) return true;
  const cutoff = normalizeObserverFilters(observer.filters).created_after;
  if (!cutoff) return true;
  const cutoffMs = timestampMillis(cutoff);
  const createdMs = timestampMillis(createdAt);
  if (cutoffMs == null || createdMs == null) return false;
  return createdMs >= cutoffMs;
}

export function observerAllowsMessage(
  observer: Pick<ObserverToken, 'filters'> | undefined,
  message: { agent_id?: string | null; agentId?: string | null; created_at?: string | null; createdAt?: Date | string | number | null },
): boolean {
  return observerAllowsAgent(observer, message.agent_id ?? message.agentId)
    && observerAllowsCreatedAt(observer, message.created_at ?? message.createdAt);
}

export type MessageObserverResource = {
  channel_id: string;
  channel_name: string;
  channel_type: number;
  conversation_id: string | null;
  agent_id: string;
  created_at: string;
};

export function observerAllowsMessageResource(
  observer: Pick<ObserverToken, 'filters' | 'scopes'> | undefined,
  resource: MessageObserverResource,
  options: { normalScope?: ObserverScope } = {},
): boolean {
  if (!observer) return true;
  if (!observerAllowsMessage(observer, resource)) return false;
  if (resource.channel_type !== 0) {
    return observerAllowsConversation(observer, resource.conversation_id);
  }
  if (options.normalScope && !hasObserverScope(observer, options.normalScope)) return false;
  return observerAllowsChannel(observer, {
    id: resource.channel_id,
    name: resource.channel_name,
    channel_type: resource.channel_type,
  });
}

export type FileObserverResource = {
  id: string;
  uploaded_by_id: string;
  created_at: string;
  attachments: Array<{
    channel_id: string;
    channel_name: string;
    channel_type: number;
    conversation_id: string | null;
  }>;
};

export function observerAllowsFile(
  observer: Pick<ObserverToken, 'filters' | 'scopes'> | undefined,
  file: FileObserverResource,
): boolean {
  if (!observer) return true;
  if (!observerAllowsAgent(observer, file.uploaded_by_id)) return false;
  if (!observerAllowsCreatedAt(observer, file.created_at)) return false;
  if (file.attachments.length === 0) {
    return !hasChannelOrDmFilter(normalizeObserverFilters(observer.filters));
  }
  return file.attachments.some((attachment) => (
    attachment.conversation_id
      ? observerAllowsConversation(observer, attachment.conversation_id)
      : observerAllowsChannel(observer, {
        id: attachment.channel_id,
        name: attachment.channel_name,
        channel_type: attachment.channel_type,
      })
  ));
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function eventChannelName(event: Record<string, unknown>): string | null {
  const channel = event.channel;
  if (typeof channel === 'string') return channel;
  const channelObject = nestedRecord(channel);
  return typeof channelObject.name === 'string' ? channelObject.name : null;
}

function eventAgentId(event: Record<string, unknown>): string | null {
  const message = nestedRecord(event.message);
  const agent = nestedRecord(event.agent);
  return (typeof event.agent_id === 'string' ? event.agent_id : null)
    ?? (typeof event.subject_agent_id === 'string' ? event.subject_agent_id : null)
    ?? (typeof message.agent_id === 'string' ? message.agent_id : null)
    ?? (typeof agent.id === 'string' ? agent.id : null);
}

function eventCreatedAt(event: Record<string, unknown>): string | Date | null {
  const message = nestedRecord(event.message);
  return (typeof event.created_at === 'string' ? event.created_at : null)
    ?? (typeof event.timestamp === 'string' ? event.timestamp : null)
    ?? (typeof message.created_at === 'string' ? message.created_at : null)
    ?? null;
}

function eventRequiredScopes(type: string): ObserverScope[] {
  if (type === 'message.created' || type === 'message.updated' || type === 'message.read' || type === 'webhook.received') return ['messages:read'];
  if (type === 'thread.reply') return ['threads:read'];
  if (type === 'message.reacted') return ['reactions:read'];
  if (type === 'dm.received' || type === 'group_dm.received') return ['dms:read'];
  if (type === 'file.uploaded') return ['files:read'];
  if (type.startsWith('agent.status.')) return ['agents:read'];
  if (type.startsWith('member.') || type.startsWith('channel.')) return ['channels:read'];
  if (type.startsWith('delivery.')) return ['deliveries:read'];
  if (type.startsWith('node.')) return ['nodes:read'];
  return ['activity:read'];
}

export function observerAllowsAnyEventType(
  observer: Pick<ObserverToken, 'filters'> | undefined,
  eventTypes: string[],
): boolean {
  if (!observer) return true;
  const filters = normalizeObserverFilters(observer.filters);
  if (!filters.event_types?.length) return true;
  return eventTypes.some((type) => filters.event_types?.includes(type));
}

export function observerAllowsEvent(
  observer: Pick<ObserverToken, 'filters' | 'scopes'> | undefined,
  event: Record<string, unknown>,
): boolean {
  if (!observer) return true;
  const filters = normalizeObserverFilters(observer.filters);
  const type = typeof event.type === 'string' ? event.type : '';

  if (filters.event_types?.length && !filters.event_types.includes(type)) {
    return false;
  }

  if (!hasAnyObserverScope(observer, eventRequiredScopes(type))) {
    return false;
  }

  if (!observerAllowsCreatedAt(observer, eventCreatedAt(event))) {
    return false;
  }

  const conversationId = typeof event.conversation_id === 'string' ? event.conversation_id : null;
  const isDm = conversationId !== null || type === 'dm.received' || type === 'group_dm.received';
  if (isDm) {
    if (!observerAllowsConversation(observer, conversationId)) {
      return false;
    }
  } else if (!observerAllowsChannel(observer, {
    id: typeof event.channel_id === 'string' ? event.channel_id : null,
    name: eventChannelName(event),
  })) {
    return false;
  }

  return observerAllowsAgent(observer, eventAgentId(event));
}

export async function getMessageObserverResource(
  db: Db,
  workspaceId: string,
  messageId: string,
): Promise<MessageObserverResource | null> {
  const [row] = await db
    .select({
      channel_id: channels.id,
      channel_name: channels.name,
      channel_type: channels.channelType,
      conversation_id: dmConversations.id,
      agent_id: messages.agentId,
      created_at: messages.createdAt,
    })
    .from(messages)
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(dmConversations, eq(dmConversations.channelId, channels.id))
    .where(and(eq(messages.id, messageId), eq(messages.workspaceId, workspaceId)));
  return row ? { ...row, created_at: row.created_at.toISOString() } : null;
}

export async function getChannelObserverResource(
  db: Db,
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string; channel_type: number } | null> {
  const [row] = await db
    .select({ id: channels.id, name: channels.name, channel_type: channels.channelType })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)));
  return row ?? null;
}

export async function getFileObserverResource(
  db: Db,
  workspaceId: string,
  fileId: string,
): Promise<FileObserverResource | null> {
  return (await getFileObserverResources(db, workspaceId, [fileId])).get(fileId) ?? null;
}

export async function getFileObserverResources(
  db: Db,
  workspaceId: string,
  fileIds: string[],
): Promise<Map<string, FileObserverResource>> {
  const ids = [...new Set(fileIds)].filter((id) => id.length > 0);
  const resources = new Map<string, FileObserverResource>();
  if (ids.length === 0) return resources;

  const files = await db
    .select({
      id: fileRows.id,
      uploaded_by_id: fileRows.uploadedBy,
      created_at: fileRows.createdAt,
    })
    .from(fileRows)
    .where(and(
      eq(fileRows.workspaceId, workspaceId),
      ne(fileRows.status, 'deleted'),
      inArray(fileRows.id, ids),
    ));
  for (const file of files) {
    resources.set(file.id, {
      id: file.id,
      uploaded_by_id: file.uploaded_by_id,
      created_at: file.created_at.toISOString(),
      attachments: [],
    });
  }
  if (resources.size === 0) return resources;

  const attachments = await db
    .select({
      file_id: messageAttachments.fileId,
      channel_id: channels.id,
      channel_name: channels.name,
      channel_type: channels.channelType,
      conversation_id: dmConversations.id,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messageAttachments.messageId, messages.id))
    .innerJoin(channels, eq(messages.channelId, channels.id))
    .leftJoin(dmConversations, eq(dmConversations.channelId, channels.id))
    .where(and(
      eq(messages.workspaceId, workspaceId),
      inArray(messageAttachments.fileId, [...resources.keys()]),
    ));

  for (const attachment of attachments) {
    const resource = resources.get(attachment.file_id);
    if (!resource) continue;
    resource.attachments.push({
      channel_id: attachment.channel_id,
      channel_name: attachment.channel_name,
      channel_type: attachment.channel_type,
      conversation_id: attachment.conversation_id,
    });
  }

  return resources;
}

export async function filterObserverFileResults<T extends { id: string }>(
  db: Db,
  workspaceId: string,
  observer: Pick<ObserverToken, 'filters' | 'scopes'> | undefined,
  results: T[],
): Promise<T[]> {
  if (!observer || results.length === 0) return results;
  const resources = await getFileObserverResources(db, workspaceId, results.map((result) => result.id));
  return results.filter((result) => {
    const resource = resources.get(result.id);
    return Boolean(resource && observerAllowsFile(observer, resource));
  });
}

export async function filterObserverSearchResults<T extends {
  channel_id?: string;
  channel_name?: string | null;
  channel_type?: number | null;
  channelType?: number | null;
  conversation_id?: string | null;
  agent_id?: string | null;
  created_at?: string | null;
}>(
  db: Db,
  workspaceId: string,
  observer: Pick<ObserverToken, 'filters' | 'scopes'> | undefined,
  results: T[],
  opts: { eventTypes?: (result: T) => string[] } = {},
): Promise<T[]> {
  if (!observer || results.length === 0) return results;

  const missingChannelIds = [...new Set(results
    .filter((result) => !result.channel_name && result.channel_id)
    .map((result) => result.channel_id as string))];
  const channelsById = new Map<string, { name: string; channel_type: number }>();
  if (missingChannelIds.length > 0) {
    const rows = await db
      .select({ id: channels.id, name: channels.name, channel_type: channels.channelType })
      .from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), inArray(channels.id, missingChannelIds)));
    for (const row of rows) channelsById.set(row.id, { name: row.name, channel_type: row.channel_type });
  }

  return results.filter((result) => {
    if (opts.eventTypes && !observerAllowsAnyEventType(observer, opts.eventTypes(result))) return false;
    if (!observerAllowsMessage(observer, result)) return false;
    if (result.conversation_id) {
      return observerAllowsConversation(observer, result.conversation_id);
    }
    const channel = result.channel_id ? channelsById.get(result.channel_id) : undefined;
    return observerAllowsChannel(observer, {
      id: result.channel_id,
      name: result.channel_name ?? channel?.name,
      channel_type: result.channel_type ?? result.channelType ?? channel?.channel_type,
    });
  });
}

export function getObserverTokenFromContext(c: { get(key: 'observerToken'): ObserverToken | undefined }): ObserverToken | undefined {
  return c.get('observerToken');
}
