import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import { channels } from '../db/schema.js';
import { requireWorkspaceKey } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { jsonCreated, jsonError, jsonNotFound, jsonOk, parseJsonBody } from '../lib/httpResponse.js';
import { getRequestLogger } from '../lib/logger.js';
import { runIdempotent } from '../middleware/idempotency.js';
import * as inboundWebhookEngine from '../engine/inboundWebhook.js';
import { fanoutToChannel } from './fanout.js';
import { routeDeliveryOutcomes } from './deliveryRouting.js';
import { resolveMailboxConfig } from '../engine/mailboxConfig.js';
import { runInBackground } from './background.js';
import { sendWebhookEvent } from './webhookOutbox.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const relayfileInboundRoutes = new Hono<AppEnv>();

const MAX_SKEW_MS = 5 * 60 * 1000;
const SECRET_LABEL = 'relayfile-inbound:v1';
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24 * 30;

const createTargetSchema = z.object({
  channel: z.string().min(1),
  provider: z.string().min(1),
  pathGlob: z.string().min(1),
});

interface RelayfileEvent {
  eventId?: string;
  type?: string;
  path?: string;
  revision?: string;
  origin?: string;
  provider?: string;
  correlationId?: string;
  timestamp?: string;
  contentHash?: string;
  snapshot?: RelayfileSnapshot;
}

interface RelayfileSnapshot {
  path?: string;
  contentType?: string;
  encoding?: string;
  content?: string;
  truncated?: boolean;
}

relayfileInboundRoutes.post('/integrations/relayfile/inbound-target', requireWorkspaceKey, rateLimit, async (c) => {
  const parsed = await parseJsonBody(c, createTargetSchema, 'invalid relayfile inbound target body');
  if (!parsed.ok) return parsed.response;

  const workspace = c.get('workspace');
  const db = c.get('db');
  const channel = await getChannelByName(db, workspace.id, parsed.data.channel);
  if (!channel) {
    return jsonNotFound(c, 'channel_not_found', `Channel "${parsed.data.channel}" not found`);
  }

  const master = c.get('engine').config?.relayfileInboundSecret?.trim();
  if (!master) {
    return jsonError(c, 'relayfile_inbound_unavailable', 'Relayfile inbound bridge is not configured', 503);
  }

  const provider = normalizeProvider(parsed.data.provider);
  const pathGlob = normalizePathGlob(parsed.data.pathGlob);
  const secret = await deriveRelayfileInboundSecret(master, {
    workspaceId: workspace.id,
    channelId: channel.id,
    provider,
    pathGlob,
  });
  const url = new URL(`/v1/integrations/relayfile/inbound/${encodeURIComponent(workspace.id)}/${encodeURIComponent(channel.id)}`, c.req.url);
  url.searchParams.set('provider', provider);
  url.searchParams.set('pathGlob', pathGlob);

  return jsonCreated(c, {
    url: url.toString(),
    secret,
    workspace_id: workspace.id,
    channel_id: channel.id,
    channel: channel.name,
    provider,
    path_glob: pathGlob,
  });
});

relayfileInboundRoutes.post('/integrations/relayfile/inbound/:workspaceId/:channelId', async (c) => {
  const logger = getRequestLogger(c, 'relayfile.inbound');
  const workspaceId = c.req.param('workspaceId');
  const channelId = c.req.param('channelId');
  const provider = normalizeProvider(c.req.query('provider') ?? '');
  const pathGlob = normalizePathGlob(c.req.query('pathGlob') ?? '');
  if (!workspaceId || !channelId || !provider || !pathGlob) {
    return jsonError(c, 'bad_request', 'missing relayfile inbound route parameters', 400);
  }

  const master = c.get('engine').config?.relayfileInboundSecret?.trim();
  if (!master) {
    return jsonError(c, 'relayfile_inbound_unavailable', 'Relayfile inbound bridge is not configured', 503);
  }

  const rawBody = await c.req.raw.clone().arrayBuffer();
  const secret = await deriveRelayfileInboundSecret(master, { workspaceId, channelId, provider, pathGlob });
  const verified = await verifyRelayfileSignature(c.req.raw.headers, rawBody, secret, Date.now());
  if (!verified.ok) {
    logger.warn('relayfile inbound signature rejected', { workspace_id: workspaceId, channel_id: channelId, reason: verified.reason });
    return jsonError(c, 'unauthorized', 'invalid relayfile signature', 401);
  }

  let event: RelayfileEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(rawBody)) as RelayfileEvent;
  } catch {
    return jsonError(c, 'bad_request', 'invalid relayfile event body', 400);
  }
  const deliveryEventId = c.req.header('X-Relay-Event-Id')?.trim() || event.eventId;

  // Without a stable dedupe key we cannot make delivery idempotent, so a
  // relayfile-cloud retry/redelivery would inject the message twice. Skip
  // cleanly (2xx) rather than inject un-deduplicated. relayfile-cloud always
  // sends X-Relay-Event-Id, so this only trips on malformed deliveries.
  if (!deliveryEventId) {
    logger.warn('relayfile inbound missing event id', { workspace_id: workspaceId, channel_id: channelId });
    return jsonOk(c, { ok: true, skipped: 'missing_event_id' });
  }

  if (!event.path || !event.type) {
    return jsonOk(c, { ok: true, skipped: 'missing_event_fields' });
  }
  if (event.provider && normalizeProvider(event.provider) !== provider) {
    return jsonOk(c, { ok: true, skipped: 'provider_mismatch' });
  }
  if (!eventMatchesGlob(event.path, pathGlob)) {
    return jsonOk(c, { ok: true, skipped: 'path_mismatch' });
  }
  if (event.origin === 'agent_write') {
    return jsonOk(c, { ok: true, skipped: 'agent_write' });
  }
  if (event.type !== 'file.created' && event.type !== 'file.updated') {
    return jsonOk(c, { ok: true, skipped: 'ignored_event_type' });
  }

  const channel = await getChannelById(c.get('db'), workspaceId, channelId);
  if (!channel) {
    return jsonOk(c, { ok: true, skipped: 'channel_not_found' });
  }

  const message = formatRelayfileEventMessage(event, provider);
  if (!message) {
    return jsonOk(c, { ok: true, skipped: 'unformatted_event' });
  }

  const mailbox = resolveMailboxConfig(c.get('engine').config, workspaceId);

  try {
    const result = await runIdempotent({
      workspaceId,
      actorId: 'relayfile-inbound',
      scope: `relayfile-inbound:${channelId}`,
      key: deliveryEventId,
      fingerprint: JSON.stringify({ path: event.path, revision: event.revision, contentHash: event.contentHash }),
      kv: c.get('engine').kv,
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
      operation: () => inboundWebhookEngine.triggerIntegrationMessage(c.get('db'), workspaceId, channelId, {
        text: message.text,
        source: `relayfile:${provider}`,
        author: message.author,
        webhookId: `relayfile:${provider}`,
        webhookName: `Relayfile ${provider}`,
        payload: {
          relayfile: {
            workspaceId: eventWorkspaceId(event),
            path: event.path,
            revision: event.revision,
            eventId: deliveryEventId,
            provider,
            contentHash: event.contentHash,
          },
          provider,
          path: event.path,
          event: event.type,
          record: message.record,
        },
      }, { mailbox }),
    });

    if (!result.replayed) {
      const eventData = {
        id: result.data.message_id,
        channel: result.data.channel,
        channel_name: result.data.channel,
        channel_id: result.data.channel_id,
        text: result.data.text,
        created_at: result.data.created_at,
        from_name: result.data.author,
        metadata: result.data.metadata,
      };
      try {
        await sendWebhookEvent(c, { type: 'message.created', workspaceId, data: eventData });
      } catch (err) {
        logger.error('relayfile inbound outbox enqueue failed', {
          workspace_id: workspaceId,
          channel_id: channelId,
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Fan out to workspace-stream subscribers (dashboard/websocket) and
      // dispatch the computed mailbox deliveries to node-connected (broker)
      // agents. Without routeDeliveryOutcomes, fanoutToChannel alone reaches only
      // workspace-stream subscribers and node agents get nothing. Both run in the
      // background so a delivery-routing hiccup never fails the ingress — it must
      // return 2xx fast, since the transport retries (and eventually DLQs) non-2xx.
      runInBackground(
        c,
        fanoutToChannel(c, channelId, 'message.created', eventData, workspaceId),
        'relayfile inbound fanout',
      );
      const deliveries = result.data._deliveries;
      if (deliveries && deliveries.length > 0) {
        runInBackground(
          c,
          routeDeliveryOutcomes(c, deliveries, 'message.created', eventData),
          'relayfile inbound deliveries',
        );
      }
      emitServerEvent(c, workspaceId, 'relaycast_server_relayfile_inbound_delivered', {
        channel_id: channelId,
        message_id: result.data.message_id,
        provider,
      });
    }

    return jsonCreated(c, { ok: true, replayed: result.replayed, message_id: result.data.message_id });
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'idempotency_in_progress') {
      return jsonOk(c, { ok: true, skipped: 'duplicate_in_progress' });
    }
    if (code === 'idempotency_key_reused') {
      logger.warn('relayfile inbound event id reused with different payload', { workspace_id: workspaceId, event_id: deliveryEventId });
      return jsonOk(c, { ok: true, skipped: 'event_id_reused' });
    }
    logger.error('relayfile inbound delivery failed', {
      workspace_id: workspaceId,
      channel_id: channelId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    // Unknown failures here mean the message insert / delivery-row write itself
    // failed — most likely transient (DB/infra), not a poison payload. Return 5xx
    // so relayfile-cloud's queue consumer retries (and eventually DLQs) instead of
    // recording the drop as a successful 2xx and silently losing the message.
    return jsonError(c, 'delivery_failed', 'inbound delivery failed', 500);
  }
});

async function getChannelByName(db: AppEnv['Variables']['db'], workspaceId: string, name: string) {
  const [row] = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)));
  return row ?? null;
}

async function getChannelById(db: AppEnv['Variables']['db'], workspaceId: string, channelId: string) {
  const [row] = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.id, channelId)));
  return row ?? null;
}

export async function deriveRelayfileInboundSecret(
  master: string,
  input: { workspaceId: string; channelId: string; provider: string; pathGlob: string },
): Promise<string> {
  const label = `${SECRET_LABEL}:${input.workspaceId}:${input.channelId}:${normalizeProvider(input.provider)}:${normalizePathGlob(input.pathGlob)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label));
  return bytesToHex(new Uint8Array(signed));
}

export async function verifyRelayfileSignature(
  headers: Headers,
  body: ArrayBuffer,
  secret: string,
  nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timestamp = headers.get('X-Relay-Timestamp')?.trim() ?? '';
  const signature = headers.get('X-Relay-Signature')?.trim().toLowerCase() ?? '';
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' };
  const timestampMs = parseRelayTimestamp(timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowMs - timestampMs) > MAX_SKEW_MS) return { ok: false, reason: 'timestamp_skew' };

  const providedHex = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  const provided = hexToBytes(providedHex);
  if (!provided) return { ok: false, reason: 'invalid_signature_encoding' };
  const raw = new TextDecoder().decode(body);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`));
  if (!constantTimeEqual(provided, new Uint8Array(signed))) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

export function formatRelayfileEventMessage(event: RelayfileEvent, provider: string): { text: string; author: string; record: unknown } | null {
  const record = parseSnapshotRecord(event.snapshot);
  const author = recordAuthor(record) ?? provider;
  const title = recordTitle(record);
  const body = recordBody(record);
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  const lines = [`${providerLabel} update`];
  if (title) lines.push(title);
  if (body && body !== title) lines.push(body);
  lines.push(`Relayfile path: ${event.path}`);
  return { text: lines.filter(Boolean).join('\n'), author, record };
}

function parseSnapshotRecord(snapshot: RelayfileSnapshot | undefined): unknown {
  if (!snapshot?.content) return null;
  if (snapshot.encoding === 'base64') return null;
  const content = snapshot.content.trim();
  if (!content) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content.slice(0, 500);
  }
}

function recordAuthor(record: unknown): string | null {
  const r = asRecord(record);
  if (!r) return null;
  return firstString(
    r.author,
    r.author_name,
    r.user_name,
    r.username,
    asRecord(r.user)?.name,
    asRecord(r.user)?.login,
    asRecord(r.assignee)?.name,
  );
}

function recordTitle(record: unknown): string | null {
  if (typeof record === 'string') return record;
  const r = asRecord(record);
  if (!r) return null;
  return firstString(r.title, r.name, r.identifier, r.subject, r.text, r.body, r.message);
}

function recordBody(record: unknown): string | null {
  const r = asRecord(record);
  if (!r) return null;
  const text = firstString(r.text, r.body, r.description, r.message, r.content);
  if (text && text.length > 1200) return `${text.slice(0, 1200)}...`;
  return text;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizePathGlob(pathGlob: string): string {
  const trimmed = pathGlob.trim();
  if (!trimmed || trimmed === '*') return '/**';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function eventMatchesGlob(path: string, glob: string): boolean {
  const normalizedPath = normalizePathGlob(path);
  const normalizedGlob = normalizePathGlob(glob);
  if (normalizedGlob === '/**' || normalizedGlob === normalizedPath) return true;
  if (normalizedGlob.endsWith('/**')) {
    const prefix = normalizedGlob.slice(0, -'/**'.length);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  if (normalizedGlob.endsWith('/*')) {
    const prefix = normalizedGlob.slice(0, -'/*'.length);
    const rest = normalizedPath.slice(prefix.length + 1);
    return normalizedPath.startsWith(`${prefix}/`) && !rest.includes('/');
  }
  if (normalizedGlob.endsWith('*')) return normalizedPath.startsWith(normalizedGlob.slice(0, -1));
  return false;
}

function eventWorkspaceId(event: RelayfileEvent): string | undefined {
  const correlation = event.correlationId ?? '';
  return correlation.startsWith('workspace:') ? correlation.slice('workspace:'.length) : undefined;
}

function parseRelayTimestamp(timestamp: string): number {
  if (/^\d+$/.test(timestamp)) {
    const seconds = Number.parseInt(timestamp, 10);
    return seconds * 1000;
  }
  return Date.parse(timestamp);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
