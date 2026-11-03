import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse, waitFor, type FakeWorkspace } from './fakeControlPlane.js';
import { startHarness, type Harness } from './harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A workspace whose deliveries list is empty until `arriveAfter` calls, recording the URLs it saw. */
function deliveriesWorkspace(arriveAfter: number) {
  const urls: string[] = [];
  const workspace: FakeWorkspace = {
    handle: (request) => {
      urls.push(request.url);
      const data = urls.length > arriveAfter ? [{ id: 'd1', status: 'queued' }] : [];
      return jsonResponse(200, { ok: true, data });
    },
  };
  return { urls, workspace };
}

describe('GET /v1/deliveries with wait', () => {
  it('re-polls the actor without `wait` until a delivery arrives', async () => {
    const { urls, workspace } = deliveriesWorkspace(2);
    harness = await startHarness({ workspace: () => workspace });
    const started = Date.now();
    const response = await fetch(`${harness.baseUrl}/v1/deliveries?wait=10000&limit=5`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    expect(response.status).toBe(200);
    expect(((await readBody(response)).data as unknown[]).length).toBe(1);
    expect(urls).toHaveLength(3);
    expect(urls.every((url) => !new URL(url).searchParams.has('wait'))).toBe(true);
    expect(new URL(urls[0]).searchParams.get('limit')).toBe('5');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(elapsed).toBeLessThan(5000);
  });

  it('returns the last empty answer at the deadline', async () => {
    const { urls, workspace } = deliveriesWorkspace(100);
    harness = await startHarness({ workspace: () => workspace });
    const started = Date.now();
    const response = await fetch(`${harness.baseUrl}/v1/deliveries?wait=1000`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    expect(response.status).toBe(200);
    expect((await readBody(response)).data).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.length).toBeLessThanOrEqual(3);
  });

  it('forwards an invalid or zero wait unchanged for the actor to answer', async () => {
    const { urls, workspace } = deliveriesWorkspace(100);
    harness = await startHarness({ workspace: () => workspace });
    const token = await harness.credential();
    for (const wait of ['0', 'abc', '99999']) {
      const response = await fetch(`${harness.baseUrl}/v1/deliveries?wait=${wait}`, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
    }
    expect(urls.map((url) => new URL(url).searchParams.get('wait'))).toEqual(['0', 'abc', '99999']);
  });

  it('stops polling when the client goes away', async () => {
    const { urls, workspace } = deliveriesWorkspace(100);
    harness = await startHarness({ workspace: () => workspace });
    const controller = new AbortController();
    const request = fetch(`${harness.baseUrl}/v1/deliveries?wait=20000`, { headers: { authorization: `Bearer ${await harness.credential()}` }, signal: controller.signal });
    await waitFor(() => urls.length >= 1);
    controller.abort();
    await expect(request).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(urls.length).toBeLessThanOrEqual(2);
  });
});

async function readBody(response: Response): Promise<{ data: unknown }> {
  return (await response.json()) as { data: unknown };
}
