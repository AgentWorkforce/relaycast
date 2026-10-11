// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_OBSERVER_MAX_RETRIES } from '../lib/connect-observer';

const router = { replace: vi.fn() };
let search = new URLSearchParams();

vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => search }));
vi.mock('@relaycast/react', () => ({ RelayProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../lib/activity-store', () => ({ resetActivityIfWorkspaceChanged: () => undefined }));

const { RelaySessionProvider } = await import('./RelaySessionProvider');

const CAPABILITY = 'ot_live_capability';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = { authenticated: true, apiKey: CAPABILITY, connectObserverId: 'ot_1', baseUrl: 'https://cast.test' };

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function open() {
  search = new URLSearchParams('observer_id=ot_1&expires_at=2999-01-01T00:00:00Z');
  window.history.replaceState({}, '', `/observer/connect?${search}#key=${CAPABILITY}`);
  render(<RelaySessionProvider mode="connect"><p>room</p></RelaySessionProvider>);
}

describe('RelaySessionProvider (Connect)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const logins = () => fetchMock.mock.calls.filter(([url]) => url === '/observer/api/auth/login');

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows the revoked state when the engine rejects the capability, without retrying', async () => {
    fetchMock.mockResolvedValue(json(401, { success: false, error: 'Invalid API key' }));
    open();
    await flush();
    expect(screen.getByText('Observer link unavailable')).toBeTruthy();
    await flush(120_000);
    expect(logins()).toHaveLength(1);
  });

  it('retries a first open the engine could not validate (rate limit or outage) with the in-memory capability', async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { success: false, error: 'Unable to validate API key' }))
      .mockImplementation(async (url: string) =>
        url === '/observer/api/auth/login' ? json(200, { success: true }) : json(200, session));
    open();
    await flush();
    expect(screen.getByText('Observer temporarily unavailable')).toBeTruthy();
    expect(screen.queryByText('Observer link unavailable')).toBeNull();
    // The capability left the address bar before validation, so a reload could not recover.
    expect(window.location.hash).toBe('');
    await flush(2_000);
    expect(logins()).toHaveLength(2);
    expect(JSON.parse(String(logins()[1]![1]!.body))).toMatchObject({ apiKey: CAPABILITY, connectObserverId: 'ot_1' });
    expect(screen.getByText('room')).toBeTruthy();
  });

  it('waits for the Retry-After the login route passes on before retrying', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false }), { status: 503, headers: { 'Retry-After': '45' } }))
      .mockImplementation(async (url: string) =>
        url === '/observer/api/auth/login' ? json(200, { success: true }) : json(200, session));
    open();
    await flush();
    await flush(44_000);
    expect(logins()).toHaveLength(1);
    await flush(1_000);
    expect(logins()).toHaveLength(2);
    expect(screen.getByText('room')).toBeTruthy();
  });

  it('does not schedule a retry for an open that fails after unmount', async () => {
    let failLogin!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { failLogin = resolve; }));
    open();
    await flush();
    cleanup();
    failLogin(json(503, { success: false, error: 'Unable to validate API key' }));
    await flush(10 * 60_000);
    expect(logins()).toHaveLength(1);
  });

  it('stops retrying after the budget and retries again only on request', async () => {
    fetchMock.mockResolvedValue(json(503, { success: false, error: 'Unable to validate API key' }));
    open();
    await flush();
    await flush(10 * 60_000);
    expect(logins()).toHaveLength(1 + CONNECT_OBSERVER_MAX_RETRIES);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    fetchMock.mockImplementation(async (url: string) =>
      url === '/observer/api/auth/login' ? json(200, { success: true }) : json(200, session));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(logins()).toHaveLength(2 + CONNECT_OBSERVER_MAX_RETRIES);
    expect(screen.getByText('room')).toBeTruthy();
  });
});
