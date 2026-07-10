import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, {
  handleRecallWebhookRequest,
  type Env,
  type RecallDedupClaim,
  type RecallDedupKey,
  type RecallWebhookDedupStore,
} from '../src/index';

const HOOKDECK_SECRET = 'hookdeck-secret';
const RECALL_SECRET = `whsec_${randomBytes(32).toString('base64')}`;
const BODY = JSON.stringify({
  event: 'sdk_upload.complete',
  data: {
    data: {
      code: 'complete',
      sub_code: null,
      updated_at: '2026-06-12T13:49:08.550355Z',
    },
    object: {
      created_at: '2026-06-12T13:48:41.345984Z',
      id: 'sdk_upload_123',
      recording_id: 'rec_123',
      status: { code: 'complete' },
    },
    recording: {
      id: 'rec_123',
      metadata: {},
    },
    sdk_upload: {
      id: 'sdk_upload_123',
      metadata: {},
    },
  },
});
const BOT_DONE_BODY = JSON.stringify({
  event: 'bot.done',
  data: {
    data: {
      code: 'done',
      sub_code: null,
      updated_at: '2026-06-15T06:30:00.000000Z',
    },
    bot: {
      id: 'bot_123',
      metadata: {},
    },
  },
});

class MemoryDedupStore implements RecallWebhookDedupStore {
  rows = new Map<string, { status: 'processing' | 'completed' | 'failed'; key: RecallDedupKey }>();

  async claim(recordingId: string): Promise<RecallDedupClaim> {
    const key = { surface: 'recall-transcription', dedupeId: `v1:${recordingId}` } as const;
    const existing = this.rows.get(recordingId);
    if (existing?.status === 'completed') {
      return { type: 'duplicate_completed', key };
    }
    if (existing?.status === 'processing') {
      return { type: 'duplicate_in_flight', key };
    }

    this.rows.set(recordingId, { status: 'processing', key });
    return {
      type: 'claimed',
      key,
      attemptCount: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
  }

  async complete(key: RecallDedupKey): Promise<void> {
    const recordingId = key.dedupeId.replace(/^v1:/, '');
    this.rows.set(recordingId, { status: 'completed', key });
  }

  async fail(key: RecallDedupKey): Promise<void> {
    const recordingId = key.dedupeId.replace(/^v1:/, '');
    this.rows.set(recordingId, { status: 'failed', key });
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    MODAL_NBWHISPER_URL: 'https://modal.test',
    MODAL_NBWHISPER_TOKEN: 'modal-token',
    HOOKDECK_WEBHOOK_SECRET: HOOKDECK_SECRET,
    RECALL_API_KEY: 'recall-key',
    RECALL_API_BASE: 'https://recall.test',
    RECALL_WORKSPACE_VERIFICATION_SECRET: RECALL_SECRET,
    RECORDER_TRANSCRIBE_TOKEN: 'recorder-token',
    TRANSCRIPTS_INGEST_URL: 'https://ingest.test',
    RECALL_WEBHOOK_DEDUP: {} as D1Database,
    ...overrides,
  };
}

function signHookdeck(body: string, secret = HOOKDECK_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function signRecall(body: string, secret = RECALL_SECRET): HeadersInit {
  const id = 'msg_123';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  };
}

function signedRequest(body = BODY, headers: HeadersInit = {}): Request {
  return new Request('https://transcription.agentrelay.com/recall/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hookdeck-signature': signHookdeck(body),
      ...signRecall(body),
      ...headers,
    },
    body,
  });
}

function mockSuccessfulFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://recall.test/api/v1/recording/rec_123/') {
      return Response.json({
        id: 'rec_123',
        started_at: '2026-06-15T06:00:00.000Z',
        meeting_metadata: { title: 'Planning' },
        media_shortcuts: {
          audio_mixed_mp3: { data: { download_url: 'https://recordings.test/rec_123.mp3' } },
        },
      });
    }
    if (url === 'https://modal.test/transcribe') {
      return Response.json({ text: 'transcribed text' });
    }
    if (url === 'https://ingest.test') {
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('transcription-worker Recall webhook ingress', () => {
  it('rejects invalid Hookdeck signatures before Recall or dedup work', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = new MemoryDedupStore();

    const response = await handleRecallWebhookRequest(
      signedRequest(BODY, { 'x-hookdeck-signature': 'bad' }),
      env(),
      undefined,
      { dedupStore: store },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('rejects invalid Recall Svix signatures after Hookdeck verification', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const store = new MemoryDedupStore();

    const response = await handleRecallWebhookRequest(
      signedRequest(BODY, { 'webhook-signature': 'v1,bad' }),
      env(),
      undefined,
      { dedupStore: store },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('uses the real sdk_upload.complete shape and dedupes a Hookdeck retry for the same recording id', async () => {
    const fetchMock = mockSuccessfulFetch();
    vi.stubGlobal('fetch', fetchMock);
    const store = new MemoryDedupStore();

    const first = await handleRecallWebhookRequest(
      signedRequest(),
      env(),
      undefined,
      { dedupStore: store },
    );
    const retry = await handleRecallWebhookRequest(
      signedRequest(),
      env(),
      undefined,
      { dedupStore: store },
    );

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith('https://recall.test/api/v1/recording/rec_123/', expect.any(Object));
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://recall.test/api/v1/recording/sdk_upload_123/',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith('https://modal.test/transcribe', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('https://ingest.test', expect.any(Object));
  });

  it('forwards Recall workspace metadata to transcripts ingest for tenant routing', async () => {
    const store = new MemoryDedupStore();
    let ingestBody: unknown;
    const body = JSON.stringify({
      event: 'sdk_upload.complete',
      data: {
        data: {
          code: 'complete',
          sub_code: null,
          updated_at: '2026-06-12T13:49:08.550355Z',
        },
        object: {
          id: 'sdk_upload_123',
          recording_id: 'rec_123',
          created_at: '2026-06-12T13:48:41.345984Z',
          status: { code: 'complete' },
        },
        recording: {
          id: 'rec_123',
          metadata: {},
        },
        sdk_upload: {
          id: 'sdk_upload_123',
          metadata: { relay_workspace_id: 'rw_workspace_upload' },
        },
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://recall.test/api/v1/recording/rec_123/') {
        return Response.json({
          id: 'rec_123',
          metadata: { relay_workspace_id: 'rw_workspace_recording' },
          desktop_sdk_upload: {
            id: 'sdk_upload_123',
            metadata: { relay_workspace_id: 'rw_workspace_upload' },
          },
          media_shortcuts: {
            audio_mixed_mp3: { data: { download_url: 'https://recordings.test/rec_123.mp3' } },
          },
        });
      }
      if (url === 'https://modal.test/transcribe') {
        return Response.json({ text: 'transcribed text' });
      }
      if (url === 'https://ingest.test') {
        ingestBody = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleRecallWebhookRequest(
      signedRequest(body),
      env(),
      undefined,
      { dedupStore: store },
    );

    expect(response.status).toBe(200);
    expect(ingestBody).toMatchObject({
      source: {
        provider: 'recall',
        recording_id: 'rec_123',
        relay_workspace_id: 'rw_workspace_upload',
      },
    });
  });

  it('processes bot.done using the real bot status webhook shape', async () => {
    const store = new MemoryDedupStore();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://recall.test/api/v1/bot/bot_123/') {
        return Response.json({
          id: 'bot_123',
          metadata: {},
          recordings: [
            {
              id: 'rec_bot_123',
              media_shortcuts: {
                audio_mixed_mp3: { data: { download_url: 'https://recordings.test/rec_bot_123.mp3' } },
              },
            },
          ],
        });
      }
      if (url === 'https://modal.test/transcribe') {
        return Response.json({ text: 'bot transcript' });
      }
      if (url === 'https://ingest.test') {
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleRecallWebhookRequest(
      signedRequest(BOT_DONE_BODY),
      env(),
      undefined,
      { dedupStore: store },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://recall.test/api/v1/bot/bot_123/', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('https://modal.test/transcribe', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('https://ingest.test', expect.any(Object));
  });

  it('returns retryable status for in-flight duplicate deliveries', async () => {
    const store = new MemoryDedupStore();
    const modalStarted = deferred<void>();
    const releaseModal = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://recall.test/api/v1/recording/rec_123/') {
        return Response.json({
          id: 'rec_123',
          media_shortcuts: {
            audio_mixed_mp3: { data: { download_url: 'https://recordings.test/rec_123.mp3' } },
          },
        });
      }
      if (url === 'https://modal.test/transcribe') {
        modalStarted.resolve();
        return releaseModal.promise;
      }
      if (url === 'https://ingest.test') {
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstPromise = handleRecallWebhookRequest(
      signedRequest(),
      env(),
      undefined,
      { dedupStore: store },
    );
    await modalStarted.promise;

    const duplicate = await handleRecallWebhookRequest(
      signedRequest(),
      env(),
      undefined,
      { dedupStore: store },
    );
    releaseModal.resolve(Response.json({ text: 'transcribed text' }));
    const first = await firstPromise;

    expect(duplicate.status).toBe(503);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: 'recall_webhook_duplicate_in_flight',
      recording_id: 'rec_123',
    });
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('marks exhausted Modal failures retryable so Hookdeck redelivery can reclaim the recording id', async () => {
    const store = new MemoryDedupStore();
    let modalAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://recall.test/api/v1/recording/rec_123/') {
        return Response.json({
          id: 'rec_123',
          media_shortcuts: {
            audio_mixed_mp3: { data: { download_url: 'https://recordings.test/rec_123.mp3' } },
          },
        });
      }
      if (url === 'https://modal.test/transcribe') {
        modalAttempts += 1;
        return modalAttempts <= 4
          ? Response.json({ error: 'temporary' }, { status: 503 })
          : Response.json({ text: 'transcribed text' });
      }
      if (url === 'https://ingest.test') {
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'unexpected url' }, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await handleRecallWebhookRequest(
      signedRequest(),
      env(),
      undefined,
      { dedupStore: store },
    );
    const retry = await handleRecallWebhookRequest(
      signedRequest(),
      env(),
      undefined,
      { dedupStore: store },
    );

    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({
      error: 'transcription_temporarily_unavailable',
      modal_status: 503,
      attempts: 4,
    });
    expect(retry.status).toBe(200);
    expect(modalAttempts).toBe(5);
    expect(store.rows.get('rec_123')?.status).toBe('completed');
  });

  it('rejects invalid recorder bearer tokens on direct non-webhook paths', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const createUpload = await worker.fetch(
      new Request('https://transcription.agentrelay.com/recall/create-upload', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
      }),
      env(),
    );
    const transcribe = await worker.fetch(
      new Request('https://transcription.agentrelay.com/transcribe', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env(),
    );

    expect(createUpload.status).toBe(401);
    expect(transcribe.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stamps optional Recall source metadata when creating SDK uploads', async () => {
    let recallBody: unknown;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      recallBody = JSON.parse(String(init?.body));
      return Response.json({ id: 'sdk_upload_123', upload_token: 'upload-token' }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://transcription.agentrelay.com/recall/create-upload', {
        method: 'POST',
        headers: {
          authorization: 'Bearer recorder-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          source: { provider: 'recall', relay_workspace_id: 'rw_workspace_a' },
        }),
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(recallBody).toMatchObject({
      metadata: { relay_workspace_id: 'rw_workspace_a' },
      recording_config: {
        audio_mixed_mp3: {},
        metadata: { relay_workspace_id: 'rw_workspace_a' },
      },
    });
  });

  it('keeps /transcribe as a bearer-authenticated non-webhook path', async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: 'direct transcript' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://transcription.agentrelay.com/transcribe', {
        method: 'POST',
        headers: {
          authorization: 'Bearer recorder-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: 'direct transcript' });
    // Norwegian (the default) sends NO explicit model, so the service applies its
    // own DEFAULT_MODEL and any NB_WHISPER_MODEL deploy override is respected.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://modal.test/transcribe?language=no',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer modal-token',
        }),
      }),
    );
  });

  it('sends an explicit model only for a specialist language (sv)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ text: 'svensk transkript' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://transcription.agentrelay.com/transcribe?language=sv', {
        method: 'POST',
        headers: {
          authorization: 'Bearer recorder-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://modal.test/transcribe?language=sv&model=KBLab%2Fkb-whisper-large',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('retries direct /transcribe Modal 429 responses before succeeding', async () => {
    let modalAttempts = 0;
    const fetchMock = vi.fn(async () => {
      modalAttempts += 1;
      return modalAttempts === 1
        ? Response.json({ error: 'rate limited' }, { status: 429 })
        : Response.json({ text: 'direct transcript after retry' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://transcription.agentrelay.com/transcribe', {
        method: 'POST',
        headers: {
          authorization: 'Bearer recorder-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: 'direct transcript after retry' });
    expect(modalAttempts).toBe(2);
  });

  it('surfaces direct /transcribe exhausted Modal 429s as temporarily unavailable', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'rate limited' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://transcription.agentrelay.com/transcribe', {
        method: 'POST',
        headers: {
          authorization: 'Bearer recorder-token',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      env(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'transcription_temporarily_unavailable',
      modal_status: 429,
      attempts: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
