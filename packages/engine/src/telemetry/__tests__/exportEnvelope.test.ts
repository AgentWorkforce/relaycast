import { describe, expect, it } from 'vitest';
import { ENGINE_OBSERVATION_FACTS, type EngineObservation, type EngineObservationKind } from '../../ports/telemetry.js';
import { WorkspaceIdNotSnowflakeError } from '../../auth/credentials.js';
import { ConfigError } from '../../bin/secretEnv.js';
import { WorkspaceDeliveryCapacityError } from '../../engine/workspaceDeliveryPolicy.js';
import { AdmissionDeniedError } from '../../lib/admissionError.js';
import { D1WriteRetryExhaustedError } from '../../lib/d1Retry.js';
import {
  ANALYTICS_DROPPED_FIELDS,
  ANALYTICS_EVENT_FIELDS,
  ANALYTICS_FIELD_RULES,
  EXPORT_ENVELOPE_VERSION,
  OTHER_VALUE,
  UNKNOWN_VALUE,
  isOpaqueId,
  projectException,
  projectFacts,
  projectObservation,
  projectOrigin,
  REGISTERED_ERROR_CODES,
  REGISTERED_ERROR_NAMES,
  traceIdOf,
  UNREGISTERED_ERROR_NAME,
  type AnalyticsFieldRule,
} from '../exportEnvelope.js';

const identity = { deployment: 'acme-prod' };
const KINDS = Object.keys(ENGINE_OBSERVATION_FACTS) as EngineObservationKind[];
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
  originName: 'POISON_ORIGIN_NAME_bob',
  originVersion: '9.9.9-POISON',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNOWFLAKE = '1234567890123456789';

/** A value that satisfies `rule`. */
function validValue(rule: AnalyticsFieldRule): string | number | boolean {
  switch (rule.type) {
    case 'id': return SNOWFLAKE;
    case 'count': return 42;
    case 'number': return 0.75;
    case 'flag': return true;
    case 'enum': return rule.values[0]!;
  }
}

/** A port fact value: valid for allowlisted fields, a named poison for dropped ones. */
function portValue(key: string): string | number | boolean {
  const rule = ANALYTICS_FIELD_RULES[key];
  return rule ? validValue(rule) : `POISON_${key.toUpperCase()}_value`;
}

function observation(kind: EngineObservationKind, extra: Record<string, unknown> = {}): EngineObservation {
  const facts: Record<string, unknown> = {
    text: POISON.text,
    body: POISON.body,
    token: POISON.token,
    authorization: POISON.authorization,
    api_key: POISON.apiKey,
    content: POISON.text,
    metadata: { secret: POISON.nested },
  };
  for (const key of ENGINE_OBSERVATION_FACTS[kind]) facts[key] = portValue(key);
  Object.assign(facts, extra);
  return {
    kind,
    occurredAt: '2026-11-08T10:00:00.000Z',
    workspaceId: 'ws_1',
    authenticatedActor: { agentId: POISON.actorId, credentialHash: POISON.credentialHash, type: 'agent' },
    sender: { id: POISON.senderId, name: POISON.senderName, type: 'human' },
    origin: { actor: `agent-relay-cli/agent/${POISON.originName}`, client: '@relaycast/sdk', version: POISON.originVersion },
    facts,
  } as EngineObservation;
}

describe('analytics allowlist', () => {
  it('classifies every ENGINE_OBSERVATION_FACTS field: allowlisted with a value rule, or dropped with a reason', () => {
    const portFields = new Set(KINDS.flatMap((kind) => [...ENGINE_OBSERVATION_FACTS[kind]] as string[]));
    const unclassified: string[] = [];
    for (const field of portFields) {
      const rule = ANALYTICS_FIELD_RULES[field];
      const dropped = ANALYTICS_DROPPED_FIELDS[field];
      if (rule) {
        expect(dropped, `${field} is both allowlisted and dropped`).toBeUndefined();
        expect(['id', 'count', 'number', 'flag', 'enum']).toContain(rule.type);
        expect(rule.doc.length, field).toBeGreaterThan(0);
      } else if (dropped) {
        expect(dropped.length, field).toBeGreaterThan(0);
      } else {
        unclassified.push(field);
      }
    }
    expect(unclassified).toEqual([]);
    // Snapshot of the classification so a change is a reviewed diff.
    const classification = Object.fromEntries([...portFields].sort().map((field) => [
      field,
      ANALYTICS_FIELD_RULES[field] ? ANALYTICS_FIELD_RULES[field]!.type : 'dropped',
    ]));
    expect(classification).toEqual({
      action_name: 'dropped',
      agent_id: 'id',
      agent_name: 'dropped',
      audit_id: 'id',
      channel_id: 'id',
      channel_name: 'dropped',
      command: 'dropped',
      conversation_id: 'id',
      duration_ms: 'count',
      emoji: 'dropped',
      file_id: 'id',
      grace_seconds: 'count',
      invited_agent_name: 'dropped',
      invocation_id: 'id',
      message_id: 'id',
      operation: 'enum',
      parent_message_id: 'id',
      provider: 'dropped',
      query_length: 'count',
      result_count: 'count',
      score: 'number',
      session_scope: 'enum',
      size_bytes: 'count',
      skill: 'dropped',
      slug: 'dropped',
      stream_mode: 'enum',
      subscription_id: 'id',
      success: 'flag',
      webhook_id: 'id',
    });
  });

  it('never allowlists names, slugs, commands, skills, actions or user strings', () => {
    for (const field of ['agent_name', 'invited_agent_name', 'channel_name', 'command', 'action_name', 'slug', 'skill', 'emoji', 'provider']) {
      expect(ANALYTICS_FIELD_RULES[field], field).toBeUndefined();
      expect(ANALYTICS_DROPPED_FIELDS[field], field).toBeTruthy();
    }
    // A name-like key may only carry a boolean or a count (e.g. changed_name, skill_count), never a string.
    for (const [field, rule] of Object.entries(ANALYTICS_FIELD_RULES)) {
      if (/name|slug|command|skill|action|text|body|content|token|secret|authorization|credential|hash|sender|emoji|provider/i.test(field)) {
        expect(['flag', 'count'], field).toContain(rule.type);
      }
    }
  });

  it('covers every observation kind, and every exported field has a rule', () => {
    expect(Object.keys(ANALYTICS_EVENT_FIELDS).sort()).toEqual([...KINDS].sort());
    for (const [kind, fields] of Object.entries(ANALYTICS_EVENT_FIELDS)) {
      for (const field of fields) {
        expect(ANALYTICS_FIELD_RULES[field], `${kind}.${field}`).toBeDefined();
        expect(ANALYTICS_DROPPED_FIELDS[field], `${kind}.${field}`).toBeUndefined();
      }
    }
  });
});

describe('projectObservation', () => {
  it.each(KINDS)('%s exports only its allowlisted facts and no poison', (kind) => {
    const event = projectObservation(observation(kind), identity)!;
    const wire = JSON.stringify(event);
    expect(wire).not.toContain('POISON');
    for (const key of ['credentialHash', 'sender', 'authenticatedActor', 'text', 'body', 'token', 'authorization', 'api_key', 'metadata', 'version', 'request_id']) {
      expect(wire).not.toContain(`"${key}"`);
    }
    expect(event).toMatchObject({
      v: EXPORT_ENVELOPE_VERSION,
      component: 'relaycast',
      deployment: 'acme-prod',
      kind,
      workspace_id: 'ws_1',
      actor_type: 'agent',
      origin: { app: 'agent-relay-cli', actor_type: 'agent', client: '@relaycast/sdk' },
      occurred_at: '2026-11-08T10:00:00.000Z',
    });
    expect(event.event_id).toMatch(UUID);
    expect(event.trace_id).toMatch(UUID);
    const portFields = ENGINE_OBSERVATION_FACTS[kind] as readonly string[];
    const expected = portFields.filter((field) => ANALYTICS_EVENT_FIELDS[kind].includes(field));
    expect(Object.keys(event.facts).sort()).toEqual([...expected].sort());
    for (const field of portFields) {
      if (ANALYTICS_DROPPED_FIELDS[field]) expect(event.facts, `${kind}.${field}`).not.toHaveProperty(field);
    }
    expect(Object.keys(event).sort()).toEqual(
      ['v', 'event_id', 'occurred_at', 'component', 'deployment', 'kind', 'workspace_id', 'trace_id', 'actor_type', 'origin', 'facts'].sort(),
    );
  });

  it('does not export agent_name from agent.updated (regression)', () => {
    const event = projectObservation(observation('agent.updated', { agent_name: 'alice-the-agent', changed_status: true }), identity)!;
    expect(event.facts).toEqual({ changed_status: true });
    expect(JSON.stringify(event)).not.toContain('alice-the-agent');
  });

  it('does not export channel_name (regression)', () => {
    for (const kind of ['channel.created', 'channel.updated', 'channel.topic.updated', 'channel.archived', 'channel.joined', 'channel.invited'] as const) {
      const event = projectObservation(observation(kind, { channel_name: 'secret-merger-room', invited_agent_name: 'bob' }), identity)!;
      const wire = JSON.stringify(event);
      expect(wire, kind).not.toContain('secret-merger-room');
      expect(wire, kind).not.toContain('"bob"');
      expect(event.facts).not.toHaveProperty('channel_name');
    }
  });

  it('does not export command, action, slug, skill, emoji or provider strings (regression)', () => {
    const cases: Array<[EngineObservationKind, Record<string, unknown>]> = [
      ['command.registered', { command: '/deploy-prod' }],
      ['command.invoked', { command: '/deploy-prod', invocation_id: SNOWFLAKE }],
      ['action.invoked', { action_name: 'wire-money', invocation_id: SNOWFLAKE }],
      ['directory.agent.updated', { slug: 'acme-secret-bot' }],
      ['directory.rating.upserted', { slug: 'acme-secret-bot', score: 4 }],
      ['route.resolved', { skill: 'tax-evasion-advice' }],
      ['route.feedback.recorded', { agent_name: 'alice', success: true }],
      ['reaction.added', { emoji: ':custom-insult:', message_id: SNOWFLAKE }],
      ['relayfile.inbound.delivered', { provider: 'acme-internal-git' }],
      ['group.dm.participant.added', { agent_name: 'carol', conversation_id: SNOWFLAKE }],
    ];
    for (const [kind, facts] of cases) {
      const event = projectObservation(observation(kind, facts), identity)!;
      const wire = JSON.stringify(event);
      for (const [key, value] of Object.entries(facts)) {
        if (ANALYTICS_DROPPED_FIELDS[key]) {
          expect(event.facts, `${kind}.${key}`).not.toHaveProperty(key);
          expect(wire, `${kind}.${key}`).not.toContain(String(value));
        }
      }
    }
  });

  it('applies value rules: ids must be opaque ids, counts non-negative integers, flags booleans', () => {
    // A name in an id field is dropped, not exported.
    expect(projectFacts('channel.created', { channel_id: 'general' })).toEqual({});
    expect(projectFacts('agent.registered', { agent_id: 'alice', agent_type: 'agent' })).toEqual({ agent_type: 'agent' });
    expect(projectFacts('file.upload.completed', { file_id: 'x'.repeat(1000), size_bytes: { evil: POISON.nested } })).toEqual({});
    expect(projectFacts('file.upload.completed', { file_id: 'file_abcdef12', size_bytes: -1 })).toEqual({ file_id: 'file_abcdef12' });
    expect(projectFacts('ws.session.ended', { session_scope: null, duration_ms: Number.POSITIVE_INFINITY })).toEqual({});
    expect(projectFacts('ws.session.ended', { session_scope: 'node', duration_ms: 1.5 })).toEqual({ session_scope: 'node' });
    expect(projectFacts('route.feedback.recorded', { success: 'yes' })).toEqual({});
    expect(projectFacts('route.resolved', { score: 0.4, fallback: false })).toEqual({ score: 0.4, fallback: false });
    expect(isOpaqueId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isOpaqueId('wh_0123456789')).toBe(true);
    for (const name of ['alice', 'general', 'wh_short', 'ws_1', 'acme_0123456789', '123456789012345678901', '']) {
      expect(isOpaqueId(name), name).toBe(false);
    }
  });

  it('maps an enum value outside its domain to other, never the raw string', () => {
    expect(projectFacts('workspace.created', { created_via: 'alice-script v2' })).toEqual({ created_via: OTHER_VALUE });
    expect(projectFacts('workspace.stream.updated', { stream_mode: 'POISON' })).toEqual({ stream_mode: OTHER_VALUE });
    expect(projectFacts('system.prompt.updated', { operation: 'reset' })).toEqual({ operation: 'reset' });
    expect(projectFacts('message.created', { message_kind: 7 })).toEqual({ message_kind: OTHER_VALUE });
  });

  it('ignores facts not allowlisted for the kind, even when allowlisted elsewhere', () => {
    expect(projectFacts('message.created', { channel_id: SNOWFLAKE, route_path: '/v1/x', score: 3, has_attachments: true }))
      .toEqual({ channel_id: SNOWFLAKE, has_attachments: true });
  });

  it('reduces origin strings to registered enums and never exports the actor name or version', () => {
    expect(projectOrigin({ actor: 'agent-relay-cli/agent/alice', client: '@relaycast/sdk', version: '1.2.3' }))
      .toEqual({ app: 'agent-relay-cli', actor_type: 'agent', client: '@relaycast/sdk' });
    expect(projectOrigin({ actor: 'Pear/User/Bob Smith', client: 'agent-relay-broker' }))
      .toEqual({ app: 'pear', actor_type: 'user', client: 'agent-relay-broker' });
    expect(projectOrigin({ actor: 'acme-internal/robot/x', client: 'acme-sdk' }))
      .toEqual({ app: OTHER_VALUE, actor_type: OTHER_VALUE, client: OTHER_VALUE });
    expect(projectOrigin({ actor: 'unknown', client: 'unknown', version: 'unknown' }))
      .toEqual({ app: UNKNOWN_VALUE, actor_type: UNKNOWN_VALUE, client: UNKNOWN_VALUE });
    expect(projectOrigin({ actor: 'a'.repeat(400), client: 7 }))
      .toEqual({ app: OTHER_VALUE, actor_type: UNKNOWN_VALUE, client: UNKNOWN_VALUE });
    expect(projectOrigin(undefined)).toEqual({ app: UNKNOWN_VALUE, actor_type: UNKNOWN_VALUE, client: UNKNOWN_VALUE });
    const event = projectObservation(observation('agent.registered'), identity)!;
    expect(JSON.stringify(event)).not.toContain(POISON.originName);
    expect(JSON.stringify(event)).not.toContain(POISON.originVersion);
    expect(Object.keys(event.origin!).sort()).toEqual(['actor_type', 'app', 'client']);
  });

  it('always sets trace_id: the well-formed request id, else a random UUID', () => {
    const withRequest = projectObservation(observation('search.executed', { request_id: 'req-0123abc' }), identity)!;
    expect(withRequest.trace_id).toBe('req-0123abc');
    expect(withRequest.facts).not.toHaveProperty('request_id');
    const a = projectObservation(observation('search.executed'), identity)!;
    const b = projectObservation(observation('search.executed'), identity)!;
    expect(a.trace_id).toMatch(UUID);
    expect(a.trace_id).not.toBe(b.trace_id);
    const malformed = projectObservation(observation('search.executed', { request_id: 'has spaces <script>' }), identity)!;
    expect(malformed.trace_id).toMatch(UUID);
    expect(traceIdOf('r'.repeat(129))).toMatch(UUID);
    expect(traceIdOf('')).toMatch(UUID);
    expect(traceIdOf(42)).toMatch(UUID);
  });

  it('omits actor_type without an authenticated actor and drops unknown kinds or a missing workspace', () => {
    const obs = observation('workspace.created');
    delete (obs as { authenticatedActor?: unknown }).authenticatedActor;
    expect(projectObservation(obs, identity)).not.toHaveProperty('actor_type');
    expect(projectObservation({ ...obs, kind: 'secret.kind' } as unknown as EngineObservation, identity)).toBeNull();
    expect(projectObservation({ ...obs, workspaceId: '' }, identity)).toBeNull();
    expect(projectObservation({ ...obs, workspaceId: undefined } as unknown as EngineObservation, identity)).toBeNull();
  });

  it('never sets a tenant id', () => {
    const event = projectObservation(observation('message.created'), identity)!;
    expect(JSON.stringify(event)).not.toContain('tenant');
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
    expect(event.trace_id).toMatch(UUID);
    expect(event).not.toHaveProperty('origin');
    expect(event).not.toHaveProperty('actor_type');
    expect(wire).not.toContain('tenant');
  });

  it('drops unknown operations, unregistered codes and non-errors', () => {
    const err = Object.assign(new Error('x'), { code: 'not a code: POISON' });
    const event = projectException(err, { source: 'POISON_SOURCE', op: 'x', path: '/v1/POISON' }, identity);
    expect(event.facts).toEqual({ error_name: 'Error' });
    expect(event.workspace_id).toBeNull();
    expect(projectException('POISON_STRING', undefined, identity).facts).toEqual({ error_name: 'NonError:string' });
    expect(JSON.stringify(projectException('POISON_STRING', undefined, identity))).not.toContain('POISON');
  });

  it('takes a context error_code, an allowlisted engine operation and the request id as trace_id', () => {
    const event = projectException(new Error('internal_error'), { error_code: 'internal_error', engine_operation: 'inbox.get', request_id: 'r1' }, identity);
    expect(event.facts).toEqual({ error_name: 'Error', error_code: 'internal_error', operation: 'inbox.get' });
    expect(event.trace_id).toBe('r1');
    expect(projectException(new Error('x'), { requestId: 'r2' }, identity).trace_id).toBe('r2');
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

  it('does not export arbitrary names or codes that match the old shape regexes; the registry is the only path', () => {
    // Shapes the pre-#636 regexes accepted: PascalCase *Error names, UPPER_SNAKE and lower_snake codes.
    const names = ['AcmeVendorError', 'AliceSmithError', 'CustomerAcmeCorpError', 'PaymentDeclinedForBobError', 'XError'];
    const codes = ['ACME_VENDOR_FAILURE', 'ALICE_SMITH', 'E_CUSTOMER_42', 'acme_failure', 'user_bob_not_found', 'ESECRETPROJECT'];
    for (const name of names) {
      expect(REGISTERED_ERROR_NAMES.has(name), name).toBe(false);
      const Ctor = { [name]: class extends Error {} }[name]!;
      expect(Ctor.name).toBe(name);
      for (const code of codes) {
        expect(REGISTERED_ERROR_CODES.has(code), code).toBe(false);
        const event = projectException(Object.assign(new Ctor('x'), { code }), { error_code: code }, identity);
        expect(event.facts, `${name}/${code}`).toEqual({ error_name: UNREGISTERED_ERROR_NAME });
        const wire = JSON.stringify(event);
        expect(wire).not.toContain(name);
        expect(wire).not.toContain(code);
      }
    }
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
