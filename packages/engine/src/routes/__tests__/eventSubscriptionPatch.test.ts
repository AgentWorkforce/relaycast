import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventSubscriptions } from '../../db/tables.js';
import { UpdateSubscriptionRequestSchema } from '@relaycast/types';
import { updateSubscription } from '../../engine/eventSubscription.js';
import { createWorkspace, makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';

const WHSEC = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;

describe('PATCH /v1/subscriptions/:id', () => {
  let stack: TestStack;
  let key: string;
  beforeEach(async () => {
    stack = makeNodeStack();
    key = (await createWorkspace(stack.app, 'sub-patch')).workspaceKey;
  });
  afterEach(() => stack.close());

  const request = (method: string, path: string, body?: unknown, token = key) => stack.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  async function create(body: Record<string, unknown> = {}): Promise<string> {
    const res = await request('POST', '/v1/subscriptions', {
      events: ['message.created'], url: 'https://hooks.example.test/a', secret: 'old-secret', ...body,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  async function patch(id: string, body: unknown, token = key) {
    const res = await request('PATCH', `/v1/subscriptions/${id}`, body, token);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) as { data: Record<string, unknown>; error?: { code: string; message: string } } };
  }

  const row = async (id: string) => (await stack.runtime.handle.db.select().from(eventSubscriptions)
    .where(eq(eventSubscriptions.id, id)))[0]!;

  it('updates each field independently and returns the GET shape without the secret', async () => {
    const id = await create({ filter: { channel: 'team' }, headers: { 'x-a': '1' } });
    const get = async () => ((await (await request('GET', `/v1/subscriptions/${id}`)).json()) as { data: unknown }).data;

    let res = await patch(id, { events: ['dm.received', 'thread.reply'] });
    expect(res.status).toBe(200);
    expect(res.json.data.events).toEqual(['dm.received', 'thread.reply']);
    expect(res.json.data).toEqual(await get());
    expect(res.json.data.filter).toEqual({ channel: 'team' });

    res = await patch(id, { filter: { recipients: ['bob', 'agt_1'] } });
    expect(res.json.data.filter).toEqual({ recipients: ['bob', 'agt_1'] });
    res = await patch(id, { filter: null });
    expect(res.json.data.filter).toBeNull();

    res = await patch(id, { url: 'https://hooks.example.test/b', headers: { 'x-a': '1' } });
    expect(res.json.data.url).toBe('https://hooks.example.test/b');

    res = await patch(id, { headers: { 'x-b': '2' } });
    expect(res.json.data.headers).toEqual({ 'x-b': '[redacted]' });
    expect((await row(id)).headers).toEqual({ 'x-b': '2' });

    res = await patch(id, { secret: 'new-secret' });
    expect(res.status).toBe(200);
    expect((await row(id)).secret).toBe('new-secret');
    res = await patch(id, { secret: null });
    expect((await row(id)).secret).toBeNull();

    res = await patch(id, { signature_scheme: 'standard-webhooks', secret: WHSEC });
    expect(res.status).toBe(200);
    expect(res.json.data.signature_scheme).toBe('standard-webhooks');

    res = await patch(id, { is_active: false });
    expect(res.json.data.is_active).toBe(false);
    expect(res.json.data).toEqual(await get());

    expect(res.json.data).not.toHaveProperty('secret');
    expect(res.text).not.toContain(WHSEC);
    expect((await row(id)).events).toEqual(['dm.received', 'thread.reply']);
  });

  it('never returns the secret it sets', async () => {
    const id = await create();
    const res = await patch(id, { secret: 'super-secret-value' });
    expect(res.status).toBe(200);
    expect(res.json.data).not.toHaveProperty('secret');
    expect(res.text).not.toContain('super-secret-value');
  });

  it('rejects an empty body and invalid fields with 400', async () => {
    const id = await create();
    const empty = await patch(id, {});
    expect(empty.status).toBe(400);
    expect(empty.json.error?.message).toBe('at least one field is required');

    for (const body of [
      { events: [] },
      { url: '' },
      { filter: { recipients: [] } },
      { filter: { recipients: Array.from({ length: 501 }, (_, i) => `a${i}`) } },
      { filter: { recipients: [''] } },
      { headers: { 'bad header': 'x' } },
      { headers: { 'x-a': 'a\r\nb' } },
      { signature_scheme: 'hmac' },
      { is_active: 'no' },
    ]) {
      const res = await patch(id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const unsafe = await patch(id, { url: 'not a url' });
    expect(unsafe.status).toBe(400);
    expect((await row(id)).url).toBe('https://hooks.example.test/a');
  });

  it('checks the whsec_ rule against the resulting row', async () => {
    const id = await create();
    // Switching scheme while the stored secret is not whsec_.
    expect((await patch(id, { signature_scheme: 'standard-webhooks' })).status).toBe(400);
    expect((await patch(id, { signature_scheme: 'standard-webhooks', secret: 'plain' })).status).toBe(400);
    expect((await patch(id, { signature_scheme: 'standard-webhooks', secret: WHSEC })).status).toBe(200);
    // Clearing or replacing the secret under standard-webhooks.
    expect((await patch(id, { secret: null })).status).toBe(400);
    expect((await patch(id, { secret: 'plain' })).status).toBe(400);
    expect((await row(id)).secret).toBe(WHSEC);
    expect((await patch(id, { signature_scheme: 'legacy', secret: 'plain' })).status).toBe(200);
  });

  it('returns 404 for an unknown id and for another workspace\'s subscription', async () => {
    const id = await create();
    expect((await patch('sub_missing', { is_active: false })).status).toBe(404);
    const other = await createWorkspace(stack.app, 'sub-patch-other');
    const res = await patch(id, { is_active: false }, other.workspaceKey);
    expect(res.status).toBe(404);
    expect(res.json.error?.code).toBe('subscription_not_found');
    expect((await row(id)).isActive).toBe(true);
  });

  it('refuses with 409 when the signing pair changed after validation, and returns null once the row is gone', async () => {
    const id = await create();
    const current = await row(id);
    const db = stack.runtime.handle.db;
    // A concurrent PATCH switched to standard-webhooks after this one read the row.
    await db.update(eventSubscriptions).set({ signatureScheme: 'standard-webhooks', secret: WHSEC })
      .where(eq(eventSubscriptions.id, id));

    await expect(updateSubscription(db, current.workspaceId, id, { secret: 'stale-legacy-secret' }, {
      signatureScheme: current.signatureScheme, secret: current.secret,
    })).rejects.toMatchObject({ code: 'subscription_update_conflict', status: 409 });
    expect(await row(id)).toMatchObject({ signatureScheme: 'standard-webhooks', secret: WHSEC });

    // Fresh expected values apply.
    const updated = await updateSubscription(db, current.workspaceId, id, { url: 'https://hooks.example.test/c' }, {
      signatureScheme: 'standard-webhooks', secret: WHSEC,
    });
    expect(updated?.url).toBe('https://hooks.example.test/c');

    expect((await request('DELETE', `/v1/subscriptions/${id}`)).status).toBe(204);
    expect(await updateSubscription(db, current.workspaceId, id, { url: 'https://hooks.example.test/d' }, {
      signatureScheme: 'standard-webhooks', secret: WHSEC,
    })).toBeNull();
  });

  describe('url change with stored headers', () => {
    const NEW_URL = 'https://hooks.example.test/new';

    it('refuses a url-only change with 400 and leaves the row unchanged', async () => {
      const id = await create({ headers: { authorization: 'Bearer old-endpoint-token' } });
      const before = await row(id);
      const res = await patch(id, { url: NEW_URL });
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe('subscription_headers_required');
      expect(res.json.error?.message).toMatch(/headers/);
      expect(res.text).not.toContain('old-endpoint-token');
      expect(await row(id)).toEqual(before);
    });

    it('stores new headers sent with the new url', async () => {
      const id = await create({ headers: { authorization: 'Bearer old' } });
      const res = await patch(id, { url: NEW_URL, headers: { authorization: 'Bearer new' } });
      expect(res.status).toBe(200);
      expect(await row(id)).toMatchObject({ url: NEW_URL, headers: { authorization: 'Bearer new' } });
    });

    it('clears the headers with null or {}', async () => {
      for (const headers of [null, {}]) {
        const id = await create({ headers: { authorization: 'Bearer old' } });
        const res = await patch(id, { url: NEW_URL, headers });
        expect(res.status, JSON.stringify(headers)).toBe(200);
        const stored = await row(id);
        expect(stored.url).toBe(NEW_URL);
        expect(stored.headers ?? {}).toEqual({});
      }
    });

    it('allows a url-only change without stored headers, and the same url with them', async () => {
      for (const headers of [undefined, {}]) {
        const id = await create(headers ? { headers } : {});
        expect((await patch(id, { url: NEW_URL })).status, JSON.stringify(headers)).toBe(200);
        expect((await row(id)).url).toBe(NEW_URL);
      }
      const id = await create({ headers: { authorization: 'Bearer old' } });
      expect((await patch(id, { url: 'https://hooks.example.test/a' })).status).toBe(200);
      expect((await row(id)).headers).toEqual({ authorization: 'Bearer old' });
    });

    it('refuses with 409 when headers were stored after a url-only change was validated', async () => {
      const id = await create();
      const current = await row(id);
      const db = stack.runtime.handle.db;
      // A concurrent PATCH stored headers after this one read the row.
      await db.update(eventSubscriptions).set({ headers: { authorization: 'Bearer old' } })
        .where(eq(eventSubscriptions.id, id));
      await expect(updateSubscription(db, current.workspaceId, id, { url: NEW_URL }, {
        signatureScheme: current.signatureScheme, secret: current.secret, url: current.url, noHeaders: true,
      })).rejects.toMatchObject({ code: 'subscription_update_conflict', status: 409 });
      // A concurrent url change also invalidates the check.
      await db.update(eventSubscriptions).set({ headers: null, url: 'https://hooks.example.test/other' })
        .where(eq(eventSubscriptions.id, id));
      await expect(updateSubscription(db, current.workspaceId, id, { url: NEW_URL }, {
        signatureScheme: current.signatureScheme, secret: current.secret, url: current.url, noHeaders: true,
      })).rejects.toMatchObject({ code: 'subscription_update_conflict', status: 409 });
      expect(await row(id)).toMatchObject({ url: 'https://hooks.example.test/other', headers: null });
    });
  });

  it('accepts exactly the bodies UpdateSubscriptionRequestSchema in @relaycast/types accepts', async () => {
    const bodies: unknown[] = [
      {}, { events: [] }, { events: ['*'] }, { events: ['custom.event'] }, { events: ['message.created'] },
      { url: '' }, { url: 'https://hooks.example.test/p' }, { headers: null }, { headers: {} },
      { headers: { 'x-a': '1' } }, { headers: { 'bad header': 'x' } }, { headers: { 'x-a': 'a\nb' } },
      { filter: null }, { filter: { recipients: [] } }, { filter: { recipients: ['bob'] } },
      { secret: null }, { secret: 'plain' }, { signature_scheme: 'hmac' }, { signature_scheme: 'legacy' },
      { is_active: 'no' }, { is_active: false },
    ];
    for (const body of bodies) {
      const id = await create();
      const res = await patch(id, body);
      const accepted = UpdateSubscriptionRequestSchema.safeParse(body).success;
      expect(res.status, JSON.stringify(body)).toBe(accepted ? 200 : 400);
    }
  });
});
