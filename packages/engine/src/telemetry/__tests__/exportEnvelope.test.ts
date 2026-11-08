import { describe, expect, it } from 'vitest';
import { ENGINE_OBSERVATION_FACTS, type EngineObservation, type EngineObservationKind } from '../../ports/telemetry.js';
import { WorkspaceIdNotSnowflakeError } from '../../auth/credentials.js';
import { ConfigError } from '../../bin/secretEnv.js';
import { WorkspaceDeliveryCapacityError } from '../../engine/workspaceDeliveryPolicy.js';
import { AdmissionDeniedError } from '../../lib/admissionError.js';
import { D1WriteRetryExhaustedError } from '../../lib/d1Retry.js';
import {
  EXPORT_ENVELOPE_VERSION,
  EXPORT_STRING_MAX,
  OPTIONAL_EXPORT_FACTS,
  projectException,
  projectObservation,
  REGISTERED_ERROR_CODES,
  REGISTERED_ERROR_NAMES,
  UNREGISTERED_ERROR_NAME,
} from '../exportEnvelope.js';

const identity = { deployment: 'acme-prod', instance: 'relaycast-0' };
const POISON = {
  credentialHash: 'POISON_CREDENTIAL_HASH_c0ffee',
  senderName: 'POISON_SENDER_NAME_alice',
  senderId: 'POISON_SENDER_ID_agent9',
  actorId: 'POISON_ACTOR_ID_agent7',
  text: 'POISON_TEXT_hello world',
  body: 'POISON_BODY_raw request',
  token: 'POISON_TOKEN_at_live_123',
  authorization: 'POISON_AUTH_Bearer xyz',
  apiKey: 'POISON_API_KEY_rk_live',
  nested: 'POISON_NESTED',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function observation(kind: EngineObservationKind): EngineObservation {
  const facts: Record<string, unknown> = {
    text: POISON.text,
    body: POISON.body,
    token: POISON.token,
    authorization: POISON.authorization,
    api_key: POISON.apiKey,
    content: POISON.text,
    metadata: { secret: POISON.nested },
  };
  for (const key of ENGINE_OBSERVATION_FACTS[kind]) facts[key] = `req_${key}`;
  return {
    kind,
    occurredAt: '2026-11-08T10:00:00.000Z',
    workspaceId: 'ws_1',
    authenticatedActor: { agentId: POISON.actorId, credentialHash: POISON.credentialHash, type: 'agent' },
    sender: { id: POISON.senderId, name: POISON.senderName, type: 'human' },
    origin: { actor: 'sdk', client: 'relaycast-ts', version: '12.8.0' },
    facts,
  } as EngineObservation;
}

describe('projectObservation', () => {
  it.each(Object.keys(ENGINE_OBSERVATION_FACTS) as EngineObservationKind[])('%s exports required facts and no poison', (kind) => {
    const event = projectObservation(observation(kind), identity)!;
    const wire = JSON.stringify(event);
    for (const value of Object.values(POISON)) expect(wire).not.toContain(value);
    for (const key of ['credentialHash', 'sender', 'authenticatedActor', 'text', 'body', 'token', 'authorization', 'api_key', 'metadata']) {
      expect(wire).not.toContain(`"${key}"`);
    }
    expect(event).toMatchObject({
      v: EXPORT_ENVELOPE_VERSION,
      component: 'relaycast',
      deployment: 'acme-prod',
      instance: 'relaycast-0',
      kind,
      workspace_id: 'ws_1',
      actor_type: 'agent',
      origin: { actor: 'sdk', client: 'relaycast-ts', version: '12.8.0' },
      occurred_at: '2026-11-08T10:00:00.000Z',
    });
    expect(event.event_id).toMatch(UUID);
    expect(Object.keys(event.facts).sort()).toEqual([...ENGINE_OBSERVATION_FACTS[kind]].sort());
    for (const key of ENGINE_OBSERVATION_FACTS[kind]) expect(event.facts[key]).toBe(`req_${key}`);
    expect(Object.keys(event).sort()).toEqual(
      ['v', 'event_id', 'occurred_at', 'component', 'deployment', 'instance', 'kind', 'workspace_id', 'actor_type', 'origin', 'facts'].sort(),
    );
  });

  it('keeps only allowlisted optional facts', () => {
    const obs = observation('message.created');
    Object.assign(obs.facts, { has_attachments: true, message_kind: 'channel_message', route_path: '/v1/x', caller_agent_id: 'a' });
    const event = projectObservation(obs, identity)!;
    expect(event.facts).toEqual({ channel_id: 'req_channel_id', message_id: 'req_message_id', has_attachments: true, message_kind: 'channel_message' });
  });

  it('never allowlists a content-, token- or credential-shaped optional key', () => {
    for (const keys of Object.values(OPTIONAL_EXPORT_FACTS)) {
      for (const key of keys ?? []) expect(key).not.toMatch(/text|body|content|token|secret|authorization|credential|hash|sender/i);
    }
  });

  it('bounds value types and truncates strings', () => {
    const obs = observation('file.upload.completed');
    Object.assign(obs.facts, { file_id: 'x'.repeat(1000), size_bytes: { evil: POISON.nested } });
    const event = projectObservation(obs, identity)!;
    expect(event.facts.file_id).toBe('x'.repeat(EXPORT_STRING_MAX));
    expect(event.facts).not.toHaveProperty('size_bytes');
    expect(JSON.stringify(event)).not.toContain(POISON.nested);

    const numbers = observation('ws.session.ended');
    Object.assign(numbers.facts, { session_scope: null, duration_ms: Number.POSITIVE_INFINITY });
    expect(projectObservation(numbers, identity)!.facts).toEqual({ session_scope: null, duration_ms: null });

    const long = observation('agent.registered');
    (long as { origin: unknown }).origin = { actor: 'a'.repeat(400), client: 7, version: undefined };
    const projected = projectObservation(long, identity)!;
    expect(projected.origin).toEqual({ actor: 'a'.repeat(EXPORT_STRING_MAX), client: 'unknown', version: 'unknown' });
  });

  it('uses a request id fact as correlation id without exporting it as a fact', () => {
    const obs = observation('search.executed');
    Object.assign(obs.facts, { request_id: 'req-0123abc' });
    const event = projectObservation(obs, identity)!;
    expect(event.correlation_id).toBe('req-0123abc');
    expect(event.facts).not.toHaveProperty('request_id');
    expect(projectObservation(observation('search.executed'), identity)).not.toHaveProperty('correlation_id');
    Object.assign(obs.facts, { request_id: 'has spaces <script>' });
    expect(projectObservation(obs, identity)).not.toHaveProperty('correlation_id');
  });

  it('omits actor_type without an authenticated actor and drops unknown kinds', () => {
    const obs = observation('workspace.created');
    delete (obs as { authenticatedActor?: unknown }).authenticatedActor;
    expect(projectObservation(obs, identity)).not.toHaveProperty('actor_type');
    expect(projectObservation({ ...obs, kind: 'secret.kind' } as unknown as EngineObservation, identity)).toBeNull();
  });
});

describe('projectException', () => {
  it('exports only a classification', () => {
    const err = new TypeError('POISON_MESSAGE token=at_live_123');
    err.stack = 'TypeError: POISON_STACK at /srv/app.js:1';
    (err as { code?: string }).code = 'SQLITE_BUSY';
    const event = projectException(err, {
      source: 'node.event_queue',
      op: 'deliver',
      workspace_id: 'ws_9',
      url: 'https://hook.example/POISON_URL',
      payload: { text: POISON.text },
    }, identity);
    const wire = JSON.stringify(event);
    for (const value of ['POISON_MESSAGE', 'POISON_STACK', 'POISON_URL', POISON.text, 'at_live_123']) expect(wire).not.toContain(value);
    expect(event.facts).toEqual({ error_name: 'TypeError', error_code: 'SQLITE_BUSY', operation: 'node.event_queue.deliver' });
    expect(event).toMatchObject({ v: 1, kind: 'exception', workspace_id: 'ws_9', component: 'relaycast', deployment: 'acme-prod' });
    expect(event).not.toHaveProperty('origin');
    expect(event).not.toHaveProperty('actor_type');
  });

  it('drops unknown operations, unregistered codes and non-errors', () => {
    const err = Object.assign(new Error('x'), { code: 'not a code: POISON' });
    const event = projectException(err, { source: 'POISON_SOURCE', op: 'x', path: '/v1/POISON' }, identity);
    expect(event.facts).toEqual({ error_name: 'Error' });
    expect(event.workspace_id).toBeNull();
    expect(projectException('POISON_STRING', undefined, identity).facts).toEqual({ error_name: 'NonError:string' });
    expect(JSON.stringify(projectException('POISON_STRING', undefined, identity))).not.toContain('POISON');
  });

  it('takes a context error_code and an allowlisted engine operation', () => {
    const event = projectException(new Error('internal_error'), { error_code: 'internal_error', engine_operation: 'inbox.get', request_id: 'r1' }, identity);
    expect(event.facts).toEqual({ error_name: 'Error', error_code: 'internal_error', operation: 'inbox.get' });
  });

  it('passes registered names and codes through', () => {
    for (const err of [
      new WorkspaceIdNotSnowflakeError('POISON_WS'),
      new WorkspaceDeliveryCapacityError('POISON_MESSAGE'),
      new D1WriteRetryExhaustedError(3, 'queue_full'),
      new AdmissionDeniedError({ message: 'POISON_MESSAGE' } as ConstructorParameters<typeof AdmissionDeniedError>[0]),
      new ConfigError('POISON_MESSAGE'),
      new RangeError('POISON_MESSAGE'),
    ]) {
      expect(REGISTERED_ERROR_NAMES.has(err.constructor.name)).toBe(true);
      expect(projectException(err, undefined, identity).facts.error_name).toBe(err.constructor.name);
    }
    for (const code of ['SQLITE_CONSTRAINT_UNIQUE', 'ECONNRESET', 'delivery_failed']) {
      expect(REGISTERED_ERROR_CODES.has(code)).toBe(true);
      expect(projectException(Object.assign(new Error('x'), { code }), undefined, identity).facts.error_code).toBe(code);
    }
  });

  it('replaces an unregistered name and omits an unregistered code, even when they look valid', () => {
    class AcmeVendorError extends Error {}
    const err = Object.assign(new AcmeVendorError('x'), { code: 'ACME_VENDOR_FAILURE' });
    expect(projectException(err, { error_code: 'acme_failure' }, identity).facts).toEqual({ error_name: UNREGISTERED_ERROR_NAME });
    expect(UNREGISTERED_ERROR_NAME).toBe('unregistered');
  });

  it('never exports a message-like name or code', () => {
    const message = 'POISON_MSG user alice@example.com token=at_live_123';
    class Leaky extends Error {}
    Object.defineProperty(Leaky, 'name', { value: message });
    const err = Object.assign(new Leaky(message), { name: message, code: message });
    const event = projectException(err, { error_code: message, message, context: { message } }, identity);
    expect(event.facts).toEqual({ error_name: UNREGISTERED_ERROR_NAME });
    const wire = JSON.stringify(event);
    for (const value of ['POISON_MSG', 'alice@example.com', 'at_live_123']) expect(wire).not.toContain(value);
  });

  it('classifies by constructor, not a reassigned name property', () => {
    const err = new Error('x');
    err.name = 'POISON_NAME';
    expect(projectException(err, undefined, identity).facts.error_name).toBe('Error');
  });
});
