import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockHomedir = vi.hoisted(() => '/mock/home');
const capturedBodies = vi.hoisted(() => [] as string[]);
const nodeRequestMock = vi.hoisted(() =>
  vi.fn(
    (
      _options: unknown,
      callback?: (res: { resume: () => void; on: (event: string, listener: () => void) => void }) => void,
    ) => {
      const endListeners: Array<() => void> = [];
      callback?.({
        resume: () => undefined,
        on: (event: string, listener: () => void) => {
          if (event === 'end') {
            endListeners.push(listener);
          }
        },
      });

      return {
        on: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
        write: vi.fn((chunk: unknown) => {
          capturedBodies.push(String(chunk));
        }),
        end: vi.fn(() => {
          for (const listener of endListeners) {
            listener();
          }
        }),
      };
    },
  ),
);

vi.mock('node:os', () => ({
  default: {
    homedir: () => mockHomedir,
  },
}));

vi.mock('node:fs');
vi.mock('node:http', () => ({
  default: {
    request: nodeRequestMock,
  },
}));
vi.mock('node:https', () => ({
  default: {
    request: nodeRequestMock,
  },
}));

import { createMcpTelemetry } from '../telemetry.js';

describe('createMcpTelemetry', () => {
  const consentPath = path.join(mockHomedir, '.relay', 'telemetry.json');
  const identityPath = path.join(mockHomedir, '.relay', 'telemetry-identity.json');
  let files: Map<string, string>;
  const event = 'relaycast_mcp_server_started';
  const bodies = () => capturedBodies.map(body => JSON.parse(body));
  const create = () => createMcpTelemetry('10.6.2', { posthogApiKey: 'phc_test' });
  const consent = (disabled = false, anonymousId = 'legacy-id') => {
    files.set(consentPath, JSON.stringify({ anonymousId, telemetryDisabled: disabled }));
  };
  const read = (file: unknown) => {
    const value = files.get(String(file));
    if (value === undefined) throw Object.assign(Error('missing'), { code: 'ENOENT' });
    return value;
  };
  beforeEach(() => {
    for (const name of ['DO_NOT_TRACK', 'RELAYCAST_TELEMETRY_DISABLED', 'RELAYCAST_POSTHOG_HOST', 'POSTHOG_HOST', 'RELAYCAST_POSTHOG_API_KEY', 'POSTHOG_API_KEY', 'RELAYCAST_TELEMETRY_DISTINCT_ID']) delete process.env[name];
    files = new Map(); consent();
    vi.mocked(fs.readFileSync).mockImplementation(read as typeof fs.readFileSync);
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { files.set(String(file), String(data)); });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      files.set(String(to), read(from)); files.delete(String(from));
    });
    vi.mocked(fs.unlinkSync).mockImplementation(file => { files.delete(String(file)); });
  });
  afterEach(() => { vi.resetAllMocks(); capturedBodies.length = 0; });

  it('ignores claimed person IDs and emits an anonymous personless envelope', async () => {
    process.env.RELAYCAST_TELEMETRY_DISTINCT_ID = 'forged-cloud-user';
    const telemetry = create(); telemetry.capture(event, { identity_source: 'spoofed', is_authenticated: true }); await telemetry.flush();
    expect(bodies()[0]).toMatchObject({ distinct_id: 'legacy-id', properties: { $process_person_profile: false, identity_source: 'anonymous', is_authenticated: false, analytics_contract_version: 2 } });
    expect(capturedBodies[0]).not.toContain('forged-cloud-user');
  });

  it.each(['unreadable', 'malformed', 'invalid-preference'])('suppresses capture when persisted consent is %s, including a pending rotation retry', async failure => {
    const telemetry = create(); telemetry.capture(event);
    vi.mocked(fs.writeFileSync).mockImplementation(() => { throw Error('unavailable'); });
    process.env.DO_NOT_TRACK = '1'; telemetry.capture(event);
    delete process.env.DO_NOT_TRACK;
    const newer = JSON.stringify({ anonymousId: 'other-process', telemetryDisabled: true });
    files.set(consentPath, failure === 'malformed' ? '{' : failure === 'invalid-preference' ? JSON.stringify({ anonymousId: 'other-process', telemetryDisabled: 'true' }) : newer);
    if (failure === 'unreadable') vi.mocked(fs.readFileSync).mockImplementation(file => {
      if (String(file) === consentPath) throw Error('EACCES'); return read(file);
    });
    vi.mocked(fs.writeFileSync).mockClear();
    telemetry.capture(event); await telemetry.flush();
    expect(capturedBodies).toHaveLength(1);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(files.get(consentPath)).toBe(failure === 'malformed' ? '{' : failure === 'invalid-preference' ? JSON.stringify({ anonymousId: 'other-process', telemetryDisabled: 'true' }) : newer);
  });

  it('rotates anonymous and session generations, shared by later instances', async () => {
    const telemetry = create(); telemetry.capture(event);
    consent(true); telemetry.capture(event); expect(capturedBodies).toHaveLength(1);
    consent(false); telemetry.capture(event);
    const next = create(); next.capture(event); await Promise.all([telemetry.flush(), next.flush()]);
    const sent = bodies(); expect(sent).toHaveLength(3);
    expect(sent[1].distinct_id).not.toBe(sent[0].distinct_id);
    expect(sent[1].properties.session_id).not.toBe(sent[0].properties.session_id);
    expect(sent[2].distinct_id).toBe(sent[1].distinct_id);
    expect(JSON.parse(files.get(identityPath)!).anonymousId).toBe(sent[1].distinct_id);
    expect(JSON.parse(files.get(consentPath)!).anonymousId).toBe('legacy-id');
  });

  it('clears its local generation after persistence and adopts a later process rotation', async () => {
    const telemetry = create(); process.env.DO_NOT_TRACK = '1'; telemetry.capture(event);
    delete process.env.DO_NOT_TRACK; telemetry.capture(event);
    const priorSession = bodies()[0].properties.session_id;
    files.set(identityPath, JSON.stringify({ anonymousId: 'later-process-generation' }));
    telemetry.capture(event); await telemetry.flush();
    expect(bodies()[1].distinct_id).toBe('later-process-generation');
    expect(bodies()[1].properties.session_id).not.toBe(priorSession);
  });

  it('rotates a second process session when adopting a generation without observing opt-out', () => {
    const first = create(); const second = create(); first.capture(event); second.capture(event);
    const prior = bodies()[1];
    process.env.DO_NOT_TRACK = '1'; first.capture(event); delete process.env.DO_NOT_TRACK;
    second.capture(event); const next = bodies()[2];
    expect(next.distinct_id).not.toBe(prior.distinct_id);
    expect(next.properties.session_id).not.toBe(prior.properties.session_id);
  });

  it('retries identity persistence without overwriting consent changed between read and write', async () => {
    const telemetry = create(); telemetry.capture(event);
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Error('EACCES'); });
    process.env.DO_NOT_TRACK = '1'; telemetry.capture(event); delete process.env.DO_NOT_TRACK;
    const rotationWrites: string[] = [];
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
      rotationWrites.push(JSON.parse(String(data)).anonymousId);
      consent(true, 'newer-optout'); // Simulate another process after our consent read.
      files.set(String(file), String(data));
    });
    telemetry.capture(event); await telemetry.flush();
    expect(capturedBodies).toHaveLength(1);
    expect(JSON.parse(files.get(consentPath)!)).toEqual({ anonymousId: 'newer-optout', telemetryDisabled: true });
    expect(vi.mocked(fs.writeFileSync).mock.calls.every(([file]) => String(file) !== consentPath)).toBe(true);
    expect(vi.mocked(fs.renameSync).mock.calls.every(([, file]) => String(file) !== consentPath)).toBe(true);
    const persistedGeneration = JSON.parse(files.get(identityPath)!).anonymousId;
    expect(persistedGeneration).not.toBe(rotationWrites[0]);
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => { files.set(String(file), String(data)); });
    consent(false, 'newer-optout');
    // Simulate restart before the original instance can retry another capture.
    const restarted = create(); restarted.capture(event);
    expect(bodies()[1].distinct_id).toBe(persistedGeneration);
    expect(bodies()[1].distinct_id).not.toBe('legacy-id');
    telemetry.capture(event);
    expect(bodies()[2].distinct_id).toBe(persistedGeneration);
  });

  it('keeps one fresh in-memory generation while persistence is unavailable', async () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => { throw Error('EACCES'); });
    const telemetry = create(); process.env.DO_NOT_TRACK = '1'; telemetry.capture(event);
    delete process.env.DO_NOT_TRACK; telemetry.capture(event); telemetry.capture(event); await telemetry.flush();
    expect(bodies()).toHaveLength(2); expect(bodies()[0].distinct_id).not.toBe('legacy-id');
    expect(bodies()[1].distinct_id).toBe(bodies()[0].distinct_id);
  });

  it('keeps failed atomic identity replacements off the shared file and retries', () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Error('EACCES'); });
    const telemetry = create(); process.env.DO_NOT_TRACK = '1'; telemetry.capture(event);
    expect(files.has(identityPath)).toBe(false);
    delete process.env.DO_NOT_TRACK; telemetry.capture(event);
    expect(JSON.parse(files.get(identityPath)!).anonymousId).toBe(bodies()[0].distinct_id);
    expect([...files.keys()].some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('rotates during opt-out even without an API key, but missing configuration alone never rotates', () => {
    const telemetry = createMcpTelemetry(); telemetry.capture(event); expect(fs.writeFileSync).not.toHaveBeenCalled();
    process.env.DO_NOT_TRACK = '1'; telemetry.capture(event);
    expect(JSON.parse(files.get(identityPath)!).anonymousId).not.toBe('legacy-id'); expect(nodeRequestMock).not.toHaveBeenCalled();
  });

  it('works without a legacy consent file and never creates or overwrites one', async () => {
    files.delete(consentPath); const telemetry = create(); telemetry.capture(event); await telemetry.flush();
    expect(capturedBodies).toHaveLength(1); expect(files.has(consentPath)).toBe(false);
    const next = create(); next.capture(event);
    expect(bodies()[1].distinct_id).toBe(bodies()[0].distinct_id);
  });

  it('posts to the hosted capture proxy with origin fields', async () => {
    const telemetry = create(); telemetry.capture(event); await telemetry.flush();
    expect(nodeRequestMock.mock.calls[0]![0]).toMatchObject({ hostname: 'i.agentrelay.com', path: '/capture/' });
    expect(bodies()[0]).toMatchObject({ api_key: 'phc_test', properties: { origin_client: '@relaycast/mcp', origin_version: '10.6.2' } });
  });
  it('allows a custom host', () => {
    const telemetry = createMcpTelemetry('1.0.0', { posthogHost: 'https://app.posthog.example/', posthogApiKey: 'phc_test' }); telemetry.capture(event);
    expect(nodeRequestMock.mock.calls[0]![0]).toMatchObject({ hostname: 'app.posthog.example', path: '/capture/' });
  });
  it('prefers fetch when worker globals are present', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal('fetch', fetch); vi.stubGlobal('WebSocketPair', class {});
    try { const telemetry = create(); telemetry.capture(event); await telemetry.flush(); expect(fetch).toHaveBeenCalledTimes(1); expect(nodeRequestMock).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  it('flushes without pending events', async () => { await expect(create().flush()).resolves.toBeUndefined(); });
});
