import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { eventSubscriptions } from '../../db/tables.js';
import { updateSubscription } from '../../engine/eventSubscription.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

// The url-change race guard of PATCH /v1/subscriptions/:id, on every dialect:
// `headers` is JSON text on SQLite and jsonb on Postgres.
describe('subscription url change with stored headers', () => {
  const OLD_URL = 'https://hooks.example.test/old';
  const NEW_URL = 'https://hooks.example.test/new';
  let stack: TestStack;
  let key: string;
  let workspaceId: string;
  beforeEach(async () => {
    stack = makeNodeStack();
    ({ workspaceKey: key, workspaceId } = await createWorkspace(stack.app, 'sub-patch-headers'));
  });
  afterEach(async () => { await stack.close(); });

  const request = (method: string, path: string, body?: unknown) => stack.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  async function create(headers?: Record<string, string>): Promise<string> {
    const res = await request('POST', '/v1/subscriptions', {
      events: ['message.created'], url: OLD_URL, secret: 'sub-secret', ...(headers ? { headers } : {}),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  const row = async (id: string) => (await stack.runtime.deps.db.select().from(eventSubscriptions)
    .where(eq(eventSubscriptions.id, id)))[0]!;

  /** A url-only update guarded as the route guards it after reading the row. */
  const guardedUrlUpdate = (id: string, expectedUrl = OLD_URL) => updateSubscription(
    stack.runtime.deps.db, workspaceId, id, { url: NEW_URL },
    { signatureScheme: 'legacy', secret: 'sub-secret', url: expectedUrl, noHeaders: true },
  );

  describe('updateSubscription with expected url and noHeaders', () => {
    it('refuses with a conflict when the row has a non-empty headers map', async () => {
      const id = await create({ authorization: 'Bearer old-endpoint-token' });
      await expect(guardedUrlUpdate(id)).rejects.toMatchObject({ code: 'subscription_update_conflict', status: 409 });
      expect(await row(id)).toMatchObject({ url: OLD_URL, headers: { authorization: 'Bearer old-endpoint-token' } });
    });

    it('updates a row whose headers are NULL', async () => {
      const id = await create();
      expect((await row(id)).headers).toBeNull();
      expect((await guardedUrlUpdate(id))?.url).toBe(NEW_URL);
      expect((await row(id)).url).toBe(NEW_URL);
    });

    it('updates a row whose stored headers are {} (as created)', async () => {
      const id = await create({});
      expect((await row(id)).headers).toEqual({});
      expect((await guardedUrlUpdate(id))?.url).toBe(NEW_URL);
      expect((await row(id)).url).toBe(NEW_URL);
    });

    it('updates a row whose stored headers are {} (written directly)', async () => {
      const id = await create({ authorization: 'Bearer old' });
      await stack.runtime.deps.db.update(eventSubscriptions).set({ headers: {} })
        .where(eq(eventSubscriptions.id, id));
      expect((await row(id)).headers).toEqual({});
      expect((await guardedUrlUpdate(id))?.url).toBe(NEW_URL);
    });

    it('refuses with a conflict when the stored url is not the expected one', async () => {
      const id = await create();
      await expect(guardedUrlUpdate(id, 'https://hooks.example.test/elsewhere'))
        .rejects.toMatchObject({ code: 'subscription_update_conflict', status: 409 });
      expect(await row(id)).toMatchObject({ url: OLD_URL, headers: null });
    });
  });

  describe('PATCH /v1/subscriptions/:id', () => {
    it('returns 400 subscription_headers_required for a url change without headers, row unchanged', async () => {
      const id = await create({ authorization: 'Bearer old-endpoint-token' });
      const before = await row(id);
      const res = await request('PATCH', `/v1/subscriptions/${id}`, { url: NEW_URL });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('subscription_headers_required');
      expect(await row(id)).toEqual(before);
    });

    it('clears the headers with headers: null', async () => {
      const id = await create({ authorization: 'Bearer old' });
      const res = await request('PATCH', `/v1/subscriptions/${id}`, { url: NEW_URL, headers: null });
      expect(res.status).toBe(200);
      const get = (await (await request('GET', `/v1/subscriptions/${id}`)).json()) as { data: { url: string; headers?: unknown } };
      expect(get.data.url).toBe(NEW_URL);
      expect(get.data.headers ?? null).toBeNull();
      expect((await row(id)).headers).toBeNull();
    });

    it('stores a new headers map sent with the url', async () => {
      const id = await create({ authorization: 'Bearer old' });
      const res = await request('PATCH', `/v1/subscriptions/${id}`, { url: NEW_URL, headers: { authorization: 'Bearer new' } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { headers: unknown } }).data.headers).toEqual({ authorization: '[redacted]' });
      expect(await row(id)).toMatchObject({ url: NEW_URL, headers: { authorization: 'Bearer new' } });
    });
  });
});
