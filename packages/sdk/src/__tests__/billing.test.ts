import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingClient } from '../billing.js';
import { HttpClient } from '../client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, apiOk = true, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () =>
      Promise.resolve(
        apiOk ? { ok: true, data } : { ok: false, error: data },
      ),
  });
}

describe('BillingClient', () => {
  let billing: BillingClient;

  beforeEach(() => {
    mockFetch.mockReset();
    billing = new BillingClient(
      new HttpClient({ apiKey: 'rk_live_test123' }),
    );
  });

  it('subscribe() posts to /v1/billing/subscribe', async () => {
    mockFetch.mockImplementation(() =>
      mockResponse({ subscription_id: 's_1', plan: 'pro', status: 'active' }),
    );
    await billing.subscribe({ plan: 'pro', payment_method: 'pm_test' });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.agentrelay.dev/v1/billing/subscribe');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ plan: 'pro', payment_method: 'pm_test' }),
    );
  });

  it('subscription() gets /v1/billing/subscription', async () => {
    mockFetch.mockImplementation(() =>
      mockResponse({ plan: 'pro', status: 'active' }),
    );
    const res = await billing.subscription();

    expect(res).toEqual({ plan: 'pro', status: 'active' });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.agentrelay.dev/v1/billing/subscription');
    expect(init.method).toBe('GET');
  });

  it('usage() gets /v1/billing/usage', async () => {
    mockFetch.mockImplementation(() =>
      mockResponse({ messages_sent: 100, api_calls: 500 }),
    );
    await billing.usage();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.agentrelay.dev/v1/billing/usage');
  });

  it('usage() passes period param', async () => {
    mockFetch.mockImplementation(() => mockResponse({}));
    await billing.usage('previous');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.agentrelay.dev/v1/billing/usage?period=previous',
    );
  });

  it('invoices() gets /v1/billing/invoices', async () => {
    mockFetch.mockImplementation(() => mockResponse([]));
    await billing.invoices();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.agentrelay.dev/v1/billing/invoices');
  });

  it('invoices() passes limit param', async () => {
    mockFetch.mockImplementation(() => mockResponse([]));
    await billing.invoices(5);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.agentrelay.dev/v1/billing/invoices?limit=5',
    );
  });

  it('portal() posts to /v1/billing/portal', async () => {
    mockFetch.mockImplementation(() =>
      mockResponse({ url: 'https://billing.stripe.com/...' }),
    );
    const res = await billing.portal();

    expect(res).toEqual({ url: 'https://billing.stripe.com/...' });
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.agentrelay.dev/v1/billing/portal');
    expect(init.method).toBe('POST');
  });
});
