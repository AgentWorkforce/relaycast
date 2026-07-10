/**
 * transcription-worker - Cloudflare glue between Recall.ai and NB-Whisper.
 *
 * Capture can be bot-free through Recall's Desktop Recording SDK, or bot-based
 * through Recall Calendar / Bot API. Both paths end here:
 *
 *   POST /recall/create-upload   called by the desktop app on `meeting-detected`.
 *                                Creates the Recall SDK upload server-side so the
 *                                RECALL_API_KEY never ships in the desktop client,
 *                                and returns { id, upload_token } for startRecording().
 *
 *   POST /recall/webhook         Hookdeck forwards Recall `sdk_upload.complete`
 *                                or `bot.done`. We verify Hookdeck first, then
 *                                Recall's Svix signature, claim the recording id,
 *                                call NB-Whisper, then deliver a granola-shaped
 *                                note so meeting-actions fires.
 *
 *   POST /transcribe             thin authed proxy to Modal (audio bytes or {url}).
 *
 * Cloudflare can't run NB-Whisper (Workers AI only serves vanilla Whisper, which
 * fails on the dialect), so the GPU model lives on Modal (services/nb-whisper).
 *
 * Bindings (vars/secrets, wired in infra/transcription-worker.ts):
 *   MODAL_NBWHISPER_URL, MODAL_NBWHISPER_TOKEN
 *   HOOKDECK_WEBHOOK_SECRET,
 *   RECALL_API_KEY, RECALL_API_BASE (region, e.g. https://us-west-2.recall.ai),
 *   RECALL_WORKSPACE_VERIFICATION_SECRET, RECORDER_TRANSCRIBE_TOKEN (auths the desktop app → worker)
 *   TRANSCRIPTS_INGEST_URL   (the granola adapter webhook)
 *   RECALL_WEBHOOK_DEDUP     (D1 binding shared with webhook-worker dedup)
 */
export interface Env {
  MODAL_NBWHISPER_URL: string;
  MODAL_NBWHISPER_TOKEN: string;
  HOOKDECK_WEBHOOK_SECRET: string;
  RECALL_API_KEY: string;
  RECALL_API_BASE: string; // e.g. https://us-west-2.recall.ai
  RECALL_WORKSPACE_VERIFICATION_SECRET: string;
  RECORDER_TRANSCRIBE_TOKEN: string;
  TRANSCRIPTS_INGEST_URL: string;
  RECALL_WEBHOOK_DEDUP: D1Database;
}

type RecallWebhookEvent = {
  event?: string;
  data?: {
    data?: {
      code?: string | null;
      sub_code?: string | null;
      updated_at?: string | null;
    };
    recording_id?: string;
    id?: string;
    object?: {
      id?: string;
      recording_id?: string | null;
      created_at?: string | null;
      status?: { code?: string | null } | null;
    };
    bot?: { id?: string; metadata?: Record<string, unknown> };
    recording?: { id?: string; metadata?: Record<string, unknown> };
    sdk_upload?: { id?: string; metadata?: Record<string, unknown> };
    metadata?: Record<string, unknown>;
  };
};

type RecallRecording = {
  id: string;
  started_at?: string | null;
  media_shortcuts?: Record<string, { data?: { download_url?: string }; status?: { code?: string } } | undefined>;
  meeting_metadata?: { title?: string | null } | null;
  metadata?: Record<string, unknown> | null;
  desktop_sdk_upload?: { id?: string | null; metadata?: Record<string, unknown> | null } | null;
  participants?: unknown;
  meeting_participants?: unknown;
};

type RecallBot = {
  id: string;
  metadata?: Record<string, unknown>;
  recordings?: RecallRecording[];
};

type RecallSourceIdentity = {
  workspaceId?: string;
  connectionId?: string;
  accountId?: string;
};

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

const HOOKDECK_SIGNATURE_HEADERS = [
  'x-hookdeck-signature',
  'x-hookdeck-signature-2',
] as const;
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const DEFAULT_RECALL_DEDUP_LEASE_MS = 6 * 60 * 60 * 1000;
const RECALL_TRANSCRIPTION_DEDUP_SURFACE = 'recall-transcription';
const MODAL_TRANSCRIBE_MAX_ATTEMPTS = 4;
const MODAL_TRANSCRIBE_RETRY_BASE_MS = 250;
const MODAL_TRANSCRIBE_RETRY_MAX_DELAY_MS = 2_000;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const recallBase = (env: Env) => (env.RECALL_API_BASE || 'https://us-west-2.recall.ai').replace(/\/+$/, '');

class ModalTranscriptionUnavailableError extends Error {
  readonly status = 503;

  constructor(
    readonly modalStatus: number | null,
    readonly attempts: number,
  ) {
    super(
      modalStatus
        ? `transcription temporarily unavailable (Modal capacity/credits): NB-Whisper returned status ${modalStatus} after ${attempts} attempts`
        : `transcription temporarily unavailable (Modal capacity/credits): NB-Whisper request failed after ${attempts} attempts`,
    );
    this.name = 'ModalTranscriptionUnavailableError';
  }
}

function isRetryableModalStatus(status: number) {
  return status === 429 || status >= 500;
}

function modalRetryDelayMs(attempt: number) {
  const delay = MODAL_TRANSCRIBE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, MODAL_TRANSCRIBE_RETRY_MAX_DELAY_MS);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modalUnavailableResponse(error: ModalTranscriptionUnavailableError) {
  return json(
    {
      error: 'transcription_temporarily_unavailable',
      message: error.message,
      modal_status: error.modalStatus,
      attempts: error.attempts,
    },
    error.status,
  );
}

// Per-language specialist checkpoints. The worker owns routing policy: it maps
// the requested language to a national-library Whisper fine-tune and tells Modal
// which checkpoint to load. One Modal deploy serves all of them (a parametrized
// class — see services/nb-whisper/app.py), each scaling to zero independently.
//
// Only list languages whose best model DIFFERS from the service default. For
// everything else (Norwegian no/nb/nn, Danish, …) the worker sends NO `model`,
// so the service applies its own DEFAULT_MODEL — which respects the
// NB_WHISPER_MODEL deploy override. Sending an explicit `model` here for those
// would silently pin them to nb-whisper-large and defeat that override.
// Keep this in sync with LANGUAGE_MODELS in app.py.
const LANGUAGE_MODELS: Record<string, string> = {
  sv: 'KBLab/kb-whisper-large', // Swedish — National Library of Sweden
};

function modelForLanguage(language: string): string | undefined {
  if (!language || language === 'auto') return undefined;
  return LANGUAGE_MODELS[language];
}

/** Call the Modal NB-Whisper endpoint. `audio` is raw bytes OR a {url}. */
async function transcribe(env: Env, audio: ArrayBuffer | { url: string }, language = 'no'): Promise<string> {
  const endpoint = env.MODAL_NBWHISPER_URL.replace(/\/+$/, '') + '/transcribe';
  const model = modelForLanguage(language);
  const isUrl = !(audio instanceof ArrayBuffer);
  const query =
    `?language=${encodeURIComponent(language)}` +
    (model ? `&model=${encodeURIComponent(model)}` : '');
  const requestUrl = endpoint + (isUrl ? '' : query);
  const requestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.MODAL_NBWHISPER_TOKEN}`,
      'content-type': isUrl ? 'application/json' : 'application/octet-stream',
    },
    body: isUrl ? JSON.stringify({ ...audio, language, ...(model ? { model } : {}) }) : audio,
  } satisfies RequestInit;

  let lastRetryableStatus: number | null = null;
  for (let attempt = 1; attempt <= MODAL_TRANSCRIBE_MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await globalThis.fetch(requestUrl, requestInit);
    } catch (error) {
      lastRetryableStatus = null;
      if (attempt >= MODAL_TRANSCRIBE_MAX_ATTEMPTS) {
        throw new ModalTranscriptionUnavailableError(null, attempt);
      }
      logWarn('Modal NB-Whisper request failed; retrying', {
        attempt,
        nextAttempt: attempt + 1,
        error: errorMessage(error),
      });
      await sleep(modalRetryDelayMs(attempt));
      continue;
    }

    if (res.ok) return (await res.json<{ text: string }>()).text;

    if (!isRetryableModalStatus(res.status)) {
      throw new Error(`modal transcription failed with status ${res.status}: ${await res.text()}`);
    }

    lastRetryableStatus = res.status;
    if (attempt >= MODAL_TRANSCRIBE_MAX_ATTEMPTS) {
      throw new ModalTranscriptionUnavailableError(lastRetryableStatus, attempt);
    }

    logWarn('Modal NB-Whisper returned retryable status; retrying', {
      attempt,
      nextAttempt: attempt + 1,
      status: res.status,
    });
    await sleep(modalRetryDelayMs(attempt));
  }

  throw new ModalTranscriptionUnavailableError(lastRetryableStatus, MODAL_TRANSCRIBE_MAX_ATTEMPTS);
}

function isAuthorized(req: Request, token: string) {
  if (!token) return false;
  const authorization = req.headers.get('authorization') ?? '';
  const bearerPrefix = 'Bearer ';
  if (!authorization.startsWith(bearerPrefix)) return false;
  return constantTimeStringEqual(authorization.slice(bearerPrefix.length), token);
}

function logInfo(message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: 'info', area: 'recall-webhook', message, ...fields }));
}

function logWarn(message: string, fields: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({ level: 'warn', area: 'recall-webhook', message, ...fields }));
}

function logError(message: string, error: unknown, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({
    level: 'error',
    area: 'recall-webhook',
    message,
    error: error instanceof Error ? error.message : String(error),
    ...fields,
  }));
}

function getHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function tryBase64ToBytes(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value);
  } catch {
    return null;
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function constantTimeStringEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let i = 0; i < maxLength; i += 1) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return diff === 0;
}

async function hmacSha256Base64(key: Uint8Array, message: string) {
  const keyBytes = new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(message),
  );
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function verifyHookdeckWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;

  const expected = tryBase64ToBytes(
    await hmacSha256Base64(new TextEncoder().encode(secret), rawBody),
  );
  if (!expected) return false;

  for (const header of HOOKDECK_SIGNATURE_HEADERS) {
    const signature = headers.get(header)?.trim();
    const candidate = signature ? tryBase64ToBytes(signature) : null;
    if (candidate && constantTimeEqual(expected, candidate)) {
      return true;
    }
  }

  return false;
}

export async function verifyRecallWebhook(req: Request, rawBody: string, secret: string) {
  const headers = getHeaders(req);
  const msgId = headers['webhook-id'] ?? headers['svix-id'];
  const msgTimestamp = headers['webhook-timestamp'] ?? headers['svix-timestamp'];
  const msgSignature = headers['webhook-signature'] ?? headers['svix-signature'];

  if (!secret || !secret.startsWith('whsec_')) {
    throw new Error('Recall webhook secret is missing or invalid');
  }
  if (!msgId || !msgTimestamp || !msgSignature) {
    throw new Error('Missing Recall webhook signature headers');
  }

  const timestampSeconds = Number(msgTimestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new Error('Invalid Recall webhook timestamp');
  }
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds);
  if (skewSeconds > SVIX_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new Error('Recall webhook timestamp outside tolerance');
  }

  const key = base64ToBytes(secret.slice('whsec_'.length));
  const expected = base64ToBytes(
    await hmacSha256Base64(key, `${msgId}.${msgTimestamp}.${rawBody}`),
  );

  for (const versionedSignature of msgSignature.split(' ')) {
    const [version, signature] = versionedSignature.split(',');
    if (version !== 'v1' || !signature) continue;
    if (constantTimeEqual(expected, base64ToBytes(signature))) return;
  }

  throw new Error('No matching Recall webhook signature found');
}

export type RecallDedupKey = {
  surface: typeof RECALL_TRANSCRIPTION_DEDUP_SURFACE;
  dedupeId: string;
};

export type RecallDedupClaim =
  | { type: 'claimed'; key: RecallDedupKey; attemptCount: number; leaseExpiresAt: Date }
  | { type: 'duplicate_completed'; key: RecallDedupKey; completedAt?: Date }
  | { type: 'duplicate_in_flight'; key: RecallDedupKey; leaseExpiresAt?: Date };

export type RecallWebhookDedupStore = {
  claim(recordingId: string, options?: { now?: Date; leaseMs?: number }): Promise<RecallDedupClaim>;
  complete(key: RecallDedupKey, options?: { now?: Date }): Promise<void>;
  fail(key: RecallDedupKey, error: unknown, options?: { now?: Date }): Promise<void>;
};

class RecallWebhookInFlightDuplicateError extends Error {
  constructor(readonly recordingId: string) {
    super(`recall recording ${recordingId} already has an in-flight transcription`);
    this.name = 'RecallWebhookInFlightDuplicateError';
  }
}

type DedupRow = {
  status: 'processing' | 'completed' | 'failed';
  attempt_count: number;
  lease_expires_at: string | null;
  completed_at: string | null;
};

function rowsFromResult<T>(result: D1Result<T>): T[] {
  return result.results ?? [];
}

function toDate(value: string | null | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringKey(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function extractRecallSourceIdentity(
  ...records: Array<Record<string, unknown> | null | undefined>
): RecallSourceIdentity {
  const workspaceKeys = [
    'relay_workspace_id',
    'relayWorkspaceId',
  ] as const;
  const connectionKeys = [
    'recall_connection_id',
    'recallConnectionId',
    'connection_id',
    'connectionId',
    'nango_connection_id',
    'nangoConnectionId',
  ] as const;
  const accountKeys = [
    'recall_account_id',
    'recallAccountId',
    'account_id',
    'accountId',
    'workspace_account_id',
    'workspaceAccountId',
  ] as const;

  for (const record of records) {
    const workspaceId = readStringKey(record, workspaceKeys);
    if (workspaceId) {
      return {
        workspaceId,
        connectionId: readStringKey(record, connectionKeys),
        accountId: readStringKey(record, accountKeys),
      };
    }
  }

  for (const record of records) {
    const connectionId = readStringKey(record, connectionKeys);
    if (connectionId) {
      return {
        connectionId,
        accountId: readStringKey(record, accountKeys),
      };
    }
  }

  for (const record of records) {
    const accountId = readStringKey(record, accountKeys);
    if (accountId) return { accountId };
  }

  return {};
}

function eventSourceIdentity(event: RecallWebhookEvent): RecallSourceIdentity {
  return extractRecallSourceIdentity(
    event.data?.metadata,
    event.data?.recording?.metadata,
    event.data?.sdk_upload?.metadata,
    event.data?.bot?.metadata,
  );
}

function sdkUploadCompleteRecordingId(event: RecallWebhookEvent): string | undefined {
  return (
    readString(event.data?.recording?.id) ??
    readString(event.data?.object?.recording_id) ??
    readString(event.data?.recording_id) ??
    readString(event.data?.id)
  );
}

function botDoneBotId(event: RecallWebhookEvent): string | undefined {
  return readString(event.data?.bot?.id) ?? readString(event.data?.id);
}

function recordingSourceIdentity(recording: RecallRecording): RecallSourceIdentity {
  return extractRecallSourceIdentity(
    recording.metadata,
    recording.desktop_sdk_upload?.metadata,
  );
}

async function readOptionalJsonRecord(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function createUploadMetadata(body: Record<string, unknown>): Record<string, string> | undefined {
  const source = isRecord(body.source) ? body.source : undefined;
  const metadata = isRecord(body.metadata) ? body.metadata : undefined;
  const identity = extractRecallSourceIdentity(metadata, source, body);
  const result: Record<string, string> = {};
  if (identity.workspaceId) result.relay_workspace_id = identity.workspaceId;
  if (identity.connectionId) result.connection_id = identity.connectionId;
  if (identity.accountId) result.account_id = identity.accountId;
  return Object.keys(result).length > 0 ? result : undefined;
}

export class D1RecallWebhookDedupStore implements RecallWebhookDedupStore {
  constructor(private readonly db: D1Database) {}

  async claim(
    recordingId: string,
    options: { now?: Date; leaseMs?: number } = {},
  ): Promise<RecallDedupClaim> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + (options.leaseMs ?? DEFAULT_RECALL_DEDUP_LEASE_MS),
    );
    const leaseExpiresAtIso = leaseExpiresAt.toISOString();

    const claimedResult = await this.db
      .prepare(`
        INSERT INTO nango_sync_dedup (
          surface,
          dedupe_id,
          provider,
          payload_hash,
          status,
          attempt_count,
          lease_expires_at,
          completed_at,
          last_error,
          updated_at
        )
        VALUES (?, ?, 'recall', ?, 'processing', 1, ?, NULL, NULL, ?)
        ON CONFLICT(surface, dedupe_id) DO UPDATE
          SET status = 'processing',
              provider = excluded.provider,
              payload_hash = excluded.payload_hash,
              attempt_count = nango_sync_dedup.attempt_count + 1,
              lease_expires_at = excluded.lease_expires_at,
              completed_at = NULL,
              last_error = NULL,
              updated_at = excluded.updated_at
          WHERE nango_sync_dedup.status = 'failed'
             OR (
               nango_sync_dedup.status = 'processing'
               AND (
                 nango_sync_dedup.lease_expires_at IS NULL
                 OR nango_sync_dedup.lease_expires_at <= ?
               )
             )
        RETURNING status, attempt_count, lease_expires_at, completed_at
      `)
      .bind(
        RECALL_TRANSCRIPTION_DEDUP_SURFACE,
        `v1:${recordingId}`,
        recordingId,
        leaseExpiresAtIso,
        nowIso,
        nowIso,
      )
      .all<DedupRow>();

    const key = {
      surface: RECALL_TRANSCRIPTION_DEDUP_SURFACE,
      dedupeId: `v1:${recordingId}`,
    } as const;
    const claimed = rowsFromResult(claimedResult)[0];
    if (claimed) {
      return {
        type: 'claimed',
        key,
        attemptCount: claimed.attempt_count,
        leaseExpiresAt: toDate(claimed.lease_expires_at) ?? leaseExpiresAt,
      };
    }

    const existingResult = await this.db
      .prepare(`
        SELECT status, attempt_count, lease_expires_at, completed_at
        FROM nango_sync_dedup
        WHERE surface = ? AND dedupe_id = ?
        LIMIT 1
      `)
      .bind(key.surface, key.dedupeId)
      .all<DedupRow>();
    const existing = rowsFromResult(existingResult)[0];

    if (existing?.status === 'completed') {
      return { type: 'duplicate_completed', key, completedAt: toDate(existing.completed_at) };
    }

    return { type: 'duplicate_in_flight', key, leaseExpiresAt: toDate(existing?.lease_expires_at) };
  }

  async complete(key: RecallDedupKey, options: { now?: Date } = {}): Promise<void> {
    const nowIso = (options.now ?? new Date()).toISOString();
    await this.db
      .prepare(`
        UPDATE nango_sync_dedup
        SET status = 'completed',
            completed_at = ?,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE surface = ? AND dedupe_id = ?
      `)
      .bind(nowIso, nowIso, key.surface, key.dedupeId)
      .run();
  }

  async fail(
    key: RecallDedupKey,
    error: unknown,
    options: { now?: Date } = {},
  ): Promise<void> {
    const nowIso = (options.now ?? new Date()).toISOString();
    await this.db
      .prepare(`
        UPDATE nango_sync_dedup
        SET status = 'failed',
            lease_expires_at = NULL,
            last_error = ?,
            updated_at = ?
        WHERE surface = ? AND dedupe_id = ?
      `)
      .bind(errorMessage(error).slice(0, 4000), nowIso, key.surface, key.dedupeId)
      .run();
  }
}

async function recallJson<T>(env: Env, path: string): Promise<T> {
  const res = await globalThis.fetch(`${recallBase(env)}${path}`, {
    headers: { authorization: `Token ${env.RECALL_API_KEY}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`recall ${path} failed with status ${res.status}`);
  return res.json<T>();
}

function recordingAudioUrl(recording: RecallRecording) {
  return (
    recording.media_shortcuts?.audio_mixed_mp3?.data?.download_url ??
    recording.media_shortcuts?.audio_mixed?.data?.download_url ??
    recording.media_shortcuts?.audio_mixed_raw?.data?.download_url ??
    recording.media_shortcuts?.video_mixed?.data?.download_url
  );
}

function noteId(input: string) {
  const cleaned = input.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48);
  return `not_${cleaned || crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);
}

async function ingestTranscript(
  env: Env,
  recording: RecallRecording,
  text: string,
  bot?: RecallBot,
  sourceIdentity: RecallSourceIdentity = {},
) {
  const ingest = await globalThis.fetch(env.TRANSCRIPTS_INGEST_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The transcripts-ingest route authenticates with the shared recorder token.
      ...(env.RECORDER_TRANSCRIBE_TOKEN
        ? { authorization: `Bearer ${env.RECORDER_TRANSCRIBE_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      id: noteId(recording.id),
      object: 'note',
      title:
        recording.meeting_metadata?.title ??
        (typeof bot?.metadata?.title === 'string' ? bot.metadata.title : undefined) ??
        'Meeting',
      created_at: recording.started_at ?? null,
      updated_at: null,
      web_url: '',
      participants: recording.participants ?? recording.meeting_participants ?? [],
      transcript_text: text,
      summary_text: text,
      source: {
        provider: 'recall',
        recording_id: recording.id,
        bot_id: bot?.id ?? null,
        ...(sourceIdentity.workspaceId ? { relay_workspace_id: sourceIdentity.workspaceId } : {}),
        ...(sourceIdentity.connectionId ? { connection_id: sourceIdentity.connectionId } : {}),
        ...(sourceIdentity.accountId ? { account_id: sourceIdentity.accountId } : {}),
      },
    }),
  });

  if (!ingest.ok) {
    throw new Error(`transcripts ingest failed with status ${ingest.status}`);
  }
}

async function processClaimedRecording(
  env: Env,
  recording: RecallRecording,
  dedupKey: RecallDedupKey,
  dedupStore: RecallWebhookDedupStore,
  bot?: RecallBot,
  sourceIdentity: RecallSourceIdentity = {},
) {
  const audioUrl = recordingAudioUrl(recording);
  if (!audioUrl) throw new Error(`recording ${recording.id} has no downloadable audio/video URL`);

  try {
    const text = await transcribe(env, { url: audioUrl });
    await ingestTranscript(env, recording, text, bot, {
      ...recordingSourceIdentity(recording),
      ...sourceIdentity,
    });
    await dedupStore.complete(dedupKey);

    logInfo('Recall recording transcription delivered', {
      recordingId: recording.id,
      botId: bot?.id ?? null,
      transcriptChars: text.length,
    });

    return { recording_id: recording.id, chars: text.length };
  } catch (error) {
    await dedupStore.fail(dedupKey, error).catch((failError) => {
      logError('Recall webhook dedup fail update failed', failError, {
        recordingId: recording.id,
      });
    });
    throw error;
  }
}

async function claimRecording(
  dedupStore: RecallWebhookDedupStore,
  recordingId: string,
): Promise<RecallDedupClaim> {
  const claim = await dedupStore.claim(recordingId);
  if (claim.type !== 'claimed') {
    logInfo('Recall webhook dedupe hit', {
      recordingId,
      dedupeStatus: claim.type === 'duplicate_completed' ? 'completed' : 'in_flight',
    });
  }
  return claim;
}

async function processRecallWebhookEvent(
  env: Env,
  event: RecallWebhookEvent,
  dedupStore: RecallWebhookDedupStore,
) {
  const webhookSourceIdentity = eventSourceIdentity(event);

  if (event.event === 'sdk_upload.complete') {
    const recordingId = sdkUploadCompleteRecordingId(event);
    if (!recordingId) throw new Error('sdk_upload.complete missing recording_id');
    const claim = await claimRecording(dedupStore, recordingId);
    if (claim.type === 'duplicate_in_flight') {
      throw new RecallWebhookInFlightDuplicateError(recordingId);
    }
    if (claim.type === 'duplicate_completed') {
      return { recording_id: recordingId, deduped: true, status: claim.type };
    }
    let recording: RecallRecording;
    try {
      recording = await recallJson<RecallRecording>(env, `/api/v1/recording/${recordingId}/`);
    } catch (error) {
      await dedupStore.fail(claim.key, error).catch((failError) => {
        logError('Recall webhook dedup fail update failed', failError, { recordingId });
      });
      throw error;
    }
    return processClaimedRecording(
      env,
      recording,
      claim.key,
      dedupStore,
      undefined,
      webhookSourceIdentity,
    );
  }

  if (event.event === 'bot.done') {
    const botId = botDoneBotId(event);
    if (!botId) throw new Error('bot.done missing bot id');
    const bot = await recallJson<RecallBot>(env, `/api/v1/bot/${botId}/`);
    const recordings = bot.recordings ?? [];
    if (recordings.length === 0) throw new Error(`bot ${botId} has no recordings`);
    const results = [];
    for (const recording of recordings) {
      const claim = await claimRecording(dedupStore, recording.id);
      if (claim.type === 'duplicate_in_flight') {
        throw new RecallWebhookInFlightDuplicateError(recording.id);
      }
      if (claim.type === 'duplicate_completed') {
        results.push({ recording_id: recording.id, deduped: true, status: claim.type });
        continue;
      }
      results.push(
        await processClaimedRecording(env, recording, claim.key, dedupStore, bot, {
          ...webhookSourceIdentity,
          ...extractRecallSourceIdentity(bot.metadata),
        }),
      );
    }
    return { bot_id: botId, recordings: results };
  }

  return { ignored: event.event ?? null };
}

const defaultDedupStores = new WeakMap<D1Database, RecallWebhookDedupStore>();

function readDedupStore(env: Env, override?: RecallWebhookDedupStore): RecallWebhookDedupStore {
  if (override) return override;
  if (!env.RECALL_WEBHOOK_DEDUP) {
    throw new Error('RECALL_WEBHOOK_DEDUP D1 binding is required');
  }

  let store = defaultDedupStores.get(env.RECALL_WEBHOOK_DEDUP);
  if (!store) {
    store = new D1RecallWebhookDedupStore(env.RECALL_WEBHOOK_DEDUP);
    defaultDedupStores.set(env.RECALL_WEBHOOK_DEDUP, store);
  }
  return store;
}

function validateRecallWebhookEvent(event: RecallWebhookEvent): Response | null {
  if (event.event === 'sdk_upload.complete') {
    const recordingId = sdkUploadCompleteRecordingId(event);
    return recordingId ? null : json({ error: 'sdk_upload.complete missing recording_id' }, 422);
  }

  if (event.event === 'bot.done') {
    const botId = botDoneBotId(event);
    return botId ? null : json({ error: 'bot.done missing bot id' }, 422);
  }

  return null;
}

export async function handleRecallWebhookRequest(
  req: Request,
  env: Env,
  _ctx?: ExecutionContextLike,
  options: { dedupStore?: RecallWebhookDedupStore } = {},
): Promise<Response> {
  const raw = await req.text();
  const hookdeckSecret = env.HOOKDECK_WEBHOOK_SECRET?.trim();

  if (!hookdeckSecret) {
    logError('Hookdeck webhook secret is not configured', new Error('missing Hookdeck secret'));
    return json({ error: 'webhook verification unavailable' }, 503);
  }

  if (!(await verifyHookdeckWebhookSignature(raw, req.headers, hookdeckSecret))) {
    logWarn('Recall webhook rejected: Hookdeck signature verification failed', {
      hasHookdeckSignature: Boolean(
        req.headers.get('x-hookdeck-signature') ?? req.headers.get('x-hookdeck-signature-2'),
      ),
    });
    return json({ error: 'invalid_hookdeck_signature' }, 401);
  }

  try {
    await verifyRecallWebhook(req, raw, env.RECALL_WORKSPACE_VERIFICATION_SECRET);
  } catch (error) {
    logWarn('Recall webhook rejected: Svix signature verification failed', {
      error: error instanceof Error ? error.message : String(error),
      hasWebhookId: Boolean(req.headers.get('webhook-id') ?? req.headers.get('svix-id')),
      hasTimestamp: Boolean(req.headers.get('webhook-timestamp') ?? req.headers.get('svix-timestamp')),
      hasSignature: Boolean(req.headers.get('webhook-signature') ?? req.headers.get('svix-signature')),
    });
    return json({ error: 'invalid_recall_signature' }, 401);
  }

  let event: RecallWebhookEvent;
  try {
    event = JSON.parse(raw) as RecallWebhookEvent;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const validationError = validateRecallWebhookEvent(event);
  if (validationError) return validationError;

  if (event.event !== 'sdk_upload.complete' && event.event !== 'bot.done') {
    logInfo('Recall webhook ignored', { event: event.event ?? null });
    return json({ ok: true, ignored: event.event ?? null });
  }

  let dedupStore: RecallWebhookDedupStore;
  try {
    dedupStore = readDedupStore(env, options.dedupStore);
  } catch (error) {
    logError('Recall webhook dedup store unavailable', error, { event: event.event });
    return json({ error: 'dedup_store_unavailable' }, 503);
  }

  try {
    const result = await processRecallWebhookEvent(env, event, dedupStore);
    return json({ ok: true, accepted: event.event ?? null, result });
  } catch (error) {
    if (error instanceof RecallWebhookInFlightDuplicateError) {
      return json(
        {
          error: 'recall_webhook_duplicate_in_flight',
          recording_id: error.recordingId,
        },
        503,
      );
    }
    if (error instanceof ModalTranscriptionUnavailableError) {
      logWarn('Recall webhook transcription temporarily unavailable', {
        event: event.event ?? null,
        modalStatus: error.modalStatus,
        attempts: error.attempts,
      });
      return modalUnavailableResponse(error);
    }
    logError('Recall webhook processing failed', error, { event: event.event ?? null });
    return json({ error: 'recall_webhook_processing_failed' }, 502);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response> {
    const { pathname } = new URL(req.url);

    // ── desktop app asks us to mint an SDK upload (key stays server-side) ─────
    if (req.method === 'POST' && pathname === '/recall/create-upload') {
      if (!isAuthorized(req, env.RECORDER_TRANSCRIBE_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const uploadMetadata = createUploadMetadata(await readOptionalJsonRecord(req));
      const recordingConfig: Record<string, unknown> = { audio_mixed_mp3: {} };
      if (uploadMetadata) recordingConfig.metadata = uploadMetadata;
      // Create an SDK upload. recording_config requests a mixed audio track (and
      // a webhook so we hear about completion). Tune as needed.
      const res = await globalThis.fetch(`${recallBase(env)}/api/v1/sdk_upload/`, {
        method: 'POST',
        headers: { authorization: `Token ${env.RECALL_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          recording_config: recordingConfig,
          ...(uploadMetadata ? { metadata: uploadMetadata } : {}),
        }),
      });
      if (!res.ok) return json({ error: `recall sdk_upload ${res.status}: ${await res.text()}` }, 502);
      const up = await res.json<{ id: string; upload_token: string }>();
      return json({ id: up.id, upload_token: up.upload_token });
    }

    // ── recording finished uploading → transcribe → deliver note ─────────────
    if (req.method === 'POST' && pathname === '/recall/webhook') {
      return handleRecallWebhookRequest(req, env, ctx);
    }

    // ── thin authed proxy to Modal ───────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/transcribe') {
      if (!isAuthorized(req, env.RECORDER_TRANSCRIBE_TOKEN)) {
        return json({ error: 'unauthorized' }, 401);
      }
      const ctype = req.headers.get('content-type') ?? '';
      const language = new URL(req.url).searchParams.get('language') ?? 'no';
      try {
        const text = ctype.startsWith('application/json')
          ? await transcribe(env, await req.json<{ url: string }>(), language)
          : await transcribe(env, await req.arrayBuffer(), language);
        return json({ text });
      } catch (err) {
        if (err instanceof ModalTranscriptionUnavailableError) {
          return modalUnavailableResponse(err);
        }
        return json({ error: String(err) }, 502);
      }
    }

    if (pathname === '/health') return json({ ok: true });
    return json({ error: 'not found' }, 404);
  },
};
