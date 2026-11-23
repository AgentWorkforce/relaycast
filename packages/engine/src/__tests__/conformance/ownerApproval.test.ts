import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  attachDirectNodeSocket,
  deliverFramesOfType,
  FakeSocket,
  type TestStack,
} from './harness.js';
import { messages } from '../../db/tables.js';

/**
 * Owner-named trusted delegates (wire contract v1, Relaycast part): a send may
 * carry `owner_approval`, validated strictly, stored immutably in its own
 * column, returned only through the recipient's by-message proof, and surfaced
 * to recipients as a `has_owner_approval` flag without its content.
 */
describe('owner_approval on messages', () => {
  let stack: TestStack;
  beforeEach(() => {
    stack = makeNodeStack({ ttlMs: 60_000 });
  });
  afterEach(async () => {
    await stack.close();
  });

  // A quote no message body below contains, so finding it in a payload means
  // approval content leaked.
  const QUOTE = 'yes merge 2250 when green ZQX-QUOTE-MARKER';
  const approval = () => ({
    v: 1,
    owner_id: 'hum_owner1',
    actions: [{ class: 'merge', target: 'AgentWorkforce/relay#2250' }],
    quote: QUOTE,
    quoted_at: '2026-11-23T07:49:00Z',
    quote_source: 'chat:dm',
    expires_at: '2026-11-23T08:49:00Z',
    approval_ref: null,
  });

  async function seed() {
    const ws = await createWorkspace(stack.app, 'owner-approval-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const created = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'ops' }),
    });
    expect(created.status).toBeLessThan(300);
    for (const agent of [alice, bob]) {
      const joined = await stack.app.request('/v1/channels/ops/join', {
        method: 'POST', headers: { authorization: `Bearer ${agent.token}` },
      });
      expect(joined.status).toBeLessThan(300);
    }
    return { ws, alice, bob, carol };
  }

  function dm(token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  }

  function post(token: string, body: Record<string, unknown>) {
    return stack.app.request('/v1/channels/ops/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  function byMessage(token: string, messageId: string) {
    return stack.app.request(`/v1/deliveries/by-message/${encodeURIComponent(messageId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function deliveries(token: string) {
    const res = await stack.app.request('/v1/deliveries', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
  }

  async function storedApproval(messageId: string) {
    const [row] = await stack.runtime.deps.db
      .select({ ownerApproval: messages.ownerApproval, metadata: messages.metadata })
      .from(messages).where(eq(messages.id, messageId));
    return row;
  }

  /** The database's refusal text: SQLite's message, or Postgres' via drizzle's `cause`. */
  async function refusal(write: PromiseLike<unknown>): Promise<string> {
    try {
      await write;
    } catch (err) {
      const error = err as { message?: string; cause?: { message?: string } };
      return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
    }
    return 'no error';
  }

  const long = (n: number) => 'x'.repeat(n);
  const invalid: Array<[string, unknown]> = [
    ['a non-object', 'approved'],
    ['an array', [approval()]],
    ['v other than 1', { ...approval(), v: 2 }],
    ['missing v', (({ v: _v, ...rest }) => rest)(approval())],
    ['missing owner_id', (({ owner_id: _o, ...rest }) => rest)(approval())],
    ['empty owner_id', { ...approval(), owner_id: '' }],
    ['owner_id over 128', { ...approval(), owner_id: long(129) }],
    ['missing actions', (({ actions: _a, ...rest }) => rest)(approval())],
    ['no actions', { ...approval(), actions: [] }],
    ['21 actions', { ...approval(), actions: Array.from({ length: 21 }, (_, i) => ({ class: 'merge', target: `o/r#${i}` })) }],
    ['an unknown class', { ...approval(), actions: [{ class: 'prompt_approval', target: 'x' }] }],
    ['a target over 256', { ...approval(), actions: [{ class: 'merge', target: long(257) }] }],
    ['a note over 280', { ...approval(), actions: [{ class: 'merge', target: 'o/r', note: long(281) }] }],
    ['an extra action key', { ...approval(), actions: [{ class: 'merge', target: 'o/r', scope: 'all' }] }],
    ['a quote over 2000', { ...approval(), quote: long(2001) }],
    ['a quote_source over 64', { ...approval(), quote_source: long(65) }],
    ['a non-RFC 3339 quoted_at', { ...approval(), quoted_at: 'yesterday' }],
    ['an expires_at without offset', { ...approval(), expires_at: '2026-11-23T08:49:00' }],
    ['a bad approval_ref', { ...approval(), approval_ref: 'apv_short' }],
    ['an approval_ref without prefix', { ...approval(), approval_ref: 'grt_abcdefgh12' }],
    ['an extra top-level key', { ...approval(), tier: 'O' }],
    // prompt_approval targets and conditions (§16.1).
    ['a prompt_approval target without a request ref', { ...approval(), actions: [{ class: 'prompt_approval', target: 'agent_123' }] }],
    ['a prompt_approval wildcard target', { ...approval(), actions: [{ class: 'prompt_approval', target: 'agent_123:*' }] }],
    ['a prompt_approval target over 256', { ...approval(), actions: [{ class: 'prompt_approval', target: `a:${long(255)}` }] }],
    ...(['ci_green', 'mergeable'] as const).map((type): [string, unknown] => [
      `${type} on prompt_approval`,
      { ...approval(), actions: [{ class: 'prompt_approval', target: 'agent_1:req_1', conditions: [{ type }] }] },
    ]),
    ['head_sha on prompt_approval', { ...approval(), actions: [{ class: 'prompt_approval', target: 'agent_1:req_1', conditions: [{ type: 'head_sha', sha: 'a'.repeat(40) }] }] }],
    ['reviews_approved on prompt_approval', { ...approval(), actions: [{ class: 'prompt_approval', target: 'agent_1:req_1', conditions: [{ type: 'reviews_approved', min: 1 }] }] }],
    ['ci_green on a repo target without #N', { ...approval(), actions: [{ class: 'merge', target: 'AgentWorkforce/relay', conditions: [{ type: 'ci_green' }] }] }],
    ['mergeable on a wildcard target', { ...approval(), actions: [{ class: 'merge', target: 'AgentWorkforce/*', conditions: [{ type: 'mergeable' }] }] }],
    ['head_sha on a deploy target', { ...approval(), actions: [{ class: 'deploy', target: 'api:staging', conditions: [{ type: 'head_sha', sha: 'a'.repeat(40) }] }] }],
    ['an unknown condition type', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'ci_passed' }] }] }],
    ['a condition without type', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ min: 1 }] }] }],
    ['a field on ci_green', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'ci_green', required: true }] }] }],
    ['a field on mergeable', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'mergeable', strict: true }] }] }],
    ['an extra field on head_sha', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'head_sha', sha: 'a'.repeat(40), ref: 'main' }] }] }],
    ['a short head_sha', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'head_sha', sha: 'a'.repeat(39) }] }] }],
    ['an uppercase head_sha', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'head_sha', sha: 'A'.repeat(40) }] }] }],
    ['head_sha without sha', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'head_sha' }] }] }],
    ['reviews_approved min 0', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'reviews_approved', min: 0 }] }] }],
    ['reviews_approved min 11', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'reviews_approved', min: 11 }] }] }],
    ['a fractional reviews_approved min', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'reviews_approved', min: 1.5 }] }] }],
    ['a string reviews_approved min', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'reviews_approved', min: '2' }] }] }],
    ['not_before without at', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'not_before' }] }] }],
    ['a non-RFC 3339 not_before', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'not_before', at: 'tomorrow 9am' }] }] }],
    ['an extra field on not_before', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: [{ type: 'not_before', at: '2026-11-23T09:00:00Z', tz: 'UTC' }] }] }],
    ['six conditions', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: Array.from({ length: 6 }, () => ({ type: 'ci_green' })) }] }],
    ['conditions that are not an array', { ...approval(), actions: [{ class: 'merge', target: 'o/r#1', conditions: { type: 'ci_green' } }] }],
  ];

  it.each(invalid)('refuses %s with 400 invalid_owner_approval on DM and channel sends', async (_label, ownerApproval) => {
    const { alice, bob } = await seed();
    for (const res of [
      await dm(alice.token, { to: 'bob', text: 'please merge', owner_approval: ownerApproval }),
      await post(alice.token, { text: 'please merge', owner_approval: ownerApproval }),
    ]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_owner_approval');
    }
    // Nothing was stored or queued.
    expect(await deliveries(bob.token)).toEqual([]);
  });

  it('accepts the bounds of the contract and treats null as no approval', async () => {
    const { alice, bob } = await seed();
    const atLimits = {
      v: 1,
      owner_id: long(128),
      actions: Array.from({ length: 20 }, (_, i) => ({
        class: (['merge', 'pr_ops', 'deploy', 'release', 'secret_change', 'destructive', 'spend', 'external_comms'] as const)[i % 8],
        target: i === 0 ? long(256) : `AgentWorkforce/*#${i}`,
        ...(i === 1 ? { note: long(280) } : {}),
      })),
      quote: long(2000),
      quoted_at: '2026-11-23T07:49:00.123+01:00',
      quote_source: long(64),
      expires_at: '2026-11-23T08:49:00Z',
      approval_ref: `apv_${'A1'.repeat(32)}`,
    };
    const full = await dm(alice.token, { to: 'bob', text: 'limits', owner_approval: atLimits });
    expect(full.status).toBe(201);
    const fullId = ((await full.json()) as { data: { id: string } }).data.id;
    expect((await storedApproval(fullId)).ownerApproval).toEqual(atLimits);

    const minimal = await dm(alice.token, { to: 'bob', text: 'minimal', owner_approval: {
      v: 1, owner_id: 'hum_k', actions: [{ class: 'pr_ops', target: 'o/r#1' }],
    } });
    expect(minimal.status).toBe(201);

    const none = await dm(alice.token, { to: 'bob', text: 'no approval', owner_approval: null });
    expect(none.status).toBe(201);
    const noneData = ((await none.json()) as { data: Record<string, unknown> }).data;
    expect(noneData).not.toHaveProperty('has_owner_approval');
    expect((await storedApproval(noneData.id as string)).ownerApproval).toBeNull();
    expect(await deliveries(bob.token)).toHaveLength(3);
  });

  it('round-trips structured conditions and prompt_approval through by-message', async () => {
    const { alice, bob } = await seed();
    const conditioned = {
      ...approval(),
      actions: [
        {
          class: 'merge',
          target: 'AgentWorkforce/relay#2250',
          conditions: [
            { type: 'ci_green' },
            { type: 'head_sha', sha: '0123456789abcdef0123456789abcdef01234567' },
            { type: 'reviews_approved', min: 10 },
            { type: 'mergeable' },
            { type: 'not_before', at: '2026-11-23T09:00:00+01:00' },
          ],
          note: 'when green',
        },
        { class: 'deploy', target: 'api:staging', conditions: [{ type: 'not_before', at: '2026-11-23T10:00:00Z' }] },
        { class: 'prompt_approval', target: 'agent_250624318991675392:req_7Q2', conditions: [{ type: 'not_before', at: '2026-11-23T08:00:00Z' }] },
        { class: 'prompt_approval', target: 'agent_1:req_2' },
      ],
    };
    for (const send of [
      () => dm(alice.token, { to: 'bob', text: 'conditioned', owner_approval: conditioned }),
      () => post(alice.token, { text: 'conditioned', owner_approval: conditioned }),
    ]) {
      const sent = await send();
      expect(sent.status).toBe(201);
      const messageId = ((await sent.json()) as { data: { id: string } }).data.id;
      expect((await storedApproval(messageId)).ownerApproval).toEqual(conditioned);
      const proof = await byMessage(bob.token, messageId);
      expect(proof.status).toBe(200);
      expect(((await proof.json()) as { data: Record<string, unknown> }).data.owner_approval).toEqual(conditioned);
    }
    // The conditions never reach the recipient's payloads either.
    const text = JSON.stringify(await deliveries(bob.token));
    expect(text).not.toContain('0123456789abcdef0123456789abcdef01234567');
    expect(text).not.toContain('reviews_approved');
  });

  it('stores the approval in its own column, never in caller metadata', async () => {
    const { alice, bob } = await seed();
    const sent = await dm(alice.token, {
      to: 'bob', text: 'please merge', owner_approval: approval(), data: { ticket: 'T-1' },
    });
    expect(sent.status).toBe(201);
    const data = ((await sent.json()) as { data: Record<string, unknown> & { id: string; message: Record<string, unknown> } }).data;
    expect(data.has_owner_approval).toBe(true);
    expect(data.message.has_owner_approval).toBe(true);
    expect(JSON.stringify(data)).not.toContain(QUOTE);

    const row = await storedApproval(data.id);
    expect(row.ownerApproval).toEqual(approval());
    expect(row.metadata).not.toHaveProperty('owner_approval');
    expect(JSON.stringify(row.metadata)).not.toContain(QUOTE);

    // A sender cannot smuggle an approval through caller-editable metadata.
    const spoof = await dm(alice.token, { to: 'bob', text: 'spoof', data: { owner_approval: approval() } });
    expect(spoof.status).toBe(201);
    const spoofId = ((await spoof.json()) as { data: { id: string } }).data.id;
    expect((await storedApproval(spoofId)).ownerApproval).toBeNull();
    const proof = await byMessage(bob.token, spoofId);
    expect(((await proof.json()) as { data: Record<string, unknown> }).data.owner_approval).toBeNull();
  });

  it('keeps the approval immutable under any message update', async () => {
    const { alice } = await seed();
    const sent = await post(alice.token, { text: 'please merge', owner_approval: approval() });
    expect(sent.status).toBe(201);
    const messageId = ((await sent.json()) as { data: { id: string } }).data.id;

    // Relaycast has no message edit route; a PATCH is never accepted.
    const edit = await stack.app.request(`/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'edited', owner_approval: { ...approval(), actions: [{ class: 'deploy', target: '*' }] } }),
    });
    expect(edit.status).toBeGreaterThanOrEqual(400);

    // An edit of the body (as any future edit path would do) leaves it alone...
    await stack.runtime.deps.db.update(messages).set({ body: 'edited body', updatedAt: new Date() })
      .where(eq(messages.id, messageId));
    expect((await storedApproval(messageId)).ownerApproval).toEqual(approval());

    // ...and the database refuses any write that changes or clears it.
    const widened = { ...approval(), actions: [{ class: 'deploy', target: '*' }] };
    expect(await refusal(stack.runtime.deps.db.update(messages).set({ ownerApproval: widened })
      .where(eq(messages.id, messageId)))).toMatch(/owner_approval is immutable/);
    expect(await refusal(stack.runtime.deps.db.update(messages).set({ ownerApproval: null })
      .where(eq(messages.id, messageId)))).toMatch(/owner_approval is immutable/);
    // Nor can one be added to a message sent without it.
    const plain = await post(alice.token, { text: 'no approval' });
    const plainId = ((await plain.json()) as { data: { id: string } }).data.id;
    expect(await refusal(stack.runtime.deps.db.update(messages).set({ ownerApproval: approval() })
      .where(eq(messages.id, plainId)))).toMatch(/owner_approval is immutable/);
    expect((await storedApproval(messageId)).ownerApproval).toEqual(approval());
  });

  it('returns the stored approval on by-message only to a pending recipient', async () => {
    const { alice, bob, carol } = await seed();
    const sent = await dm(alice.token, { to: 'bob', text: 'please merge', owner_approval: approval() });
    const messageId = ((await sent.json()) as { data: { id: string } }).data.id;

    const own = await byMessage(bob.token, messageId);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      message_id: messageId, sender_agent_id: alice.agentId, owner_approval: approval(),
    });
    // The sender and a non-recipient get the same 404 as an unknown id.
    for (const token of [alice.token, carol.token]) {
      const denied = await byMessage(token, messageId);
      expect(denied.status).toBe(404);
      const text = await denied.text();
      expect(text).toContain('delivery_not_found');
      expect(text).not.toContain(QUOTE);
    }

    // A channel message: each pending recipient proves its own delivery.
    const posted = await post(alice.token, { text: 'channel merge', owner_approval: approval() });
    const channelMessageId = ((await posted.json()) as { data: { id: string } }).data.id;
    const channelProof = await byMessage(bob.token, channelMessageId);
    expect(((await channelProof.json()) as { data: Record<string, unknown> }).data.owner_approval).toEqual(approval());
    expect((await byMessage(carol.token, channelMessageId)).status).toBe(404);

    // Without an approval the field is present and null.
    const plain = await dm(alice.token, { to: 'bob', text: 'hello' });
    const plainId = ((await plain.json()) as { data: { id: string } }).data.id;
    const plainProof = await byMessage(bob.token, plainId);
    expect(((await plainProof.json()) as { data: Record<string, unknown> }).data.owner_approval).toBeNull();
  });

  it('flags recipient payloads with has_owner_approval and never carries the content', async () => {
    const { ws, alice, bob } = await seed();
    const { sock: bobNode } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const sentDm = await dm(alice.token, { to: 'bob', text: 'please merge', owner_approval: approval() });
    const dmId = ((await sentDm.json()) as { data: { id: string } }).data.id;
    const posted = await post(alice.token, { text: 'channel merge', owner_approval: approval() });
    const postId = ((await posted.json()) as { data: { id: string } }).data.id;
    const plain = await dm(alice.token, { to: 'bob', text: 'just chatting' });
    const plainId = ((await plain.json()) as { data: { id: string } }).data.id;
    await stack.settle();

    // Node deliver frames (the recipient node's live path).
    const dmFrames = deliverFramesOfType(bobNode, 'dm.received');
    const flagged = dmFrames.find((f) => (f.msg_id as string) === dmId)!;
    const flaggedData = (flagged.payload as { data: Record<string, unknown> & { message: Record<string, unknown> } }).data;
    expect(flaggedData.message.has_owner_approval).toBe(true);
    const plainFrame = dmFrames.find((f) => (f.msg_id as string) === plainId)!;
    const plainData = (plainFrame.payload as { data: Record<string, unknown> & { message: Record<string, unknown> } }).data;
    expect(plainData.message).not.toHaveProperty('has_owner_approval');
    expect(plainData).not.toHaveProperty('has_owner_approval');
    const channelFrame = deliverFramesOfType(bobNode, 'message.created').find((f) => (f.msg_id as string) === postId)!;
    expect((channelFrame.payload as { data: Record<string, unknown> }).data.has_owner_approval).toBe(true);

    // Websocket events in the client shape.
    const dmEvent = stream.ofType('dm.received').find((e) => (e.message as { id: string }).id === dmId)!;
    expect((dmEvent.message as Record<string, unknown>).has_owner_approval).toBe(true);
    const plainEvent = stream.ofType('dm.received').find((e) => (e.message as { id: string }).id === plainId)!;
    expect(plainEvent.message).not.toHaveProperty('has_owner_approval');
    const channelEvent = stream.ofType('message.created').find((e) => (e.message as { id: string }).id === postId)!;
    expect((channelEvent.message as Record<string, unknown>).has_owner_approval).toBe(true);

    // The inbox read.
    const items = await deliveries(bob.token);
    const byId = new Map(items.map((item) => [(item.message as { id: string }).id, item.message as Record<string, unknown>]));
    expect(byId.get(dmId)!.has_owner_approval).toBe(true);
    expect(byId.get(postId)!.has_owner_approval).toBe(true);
    expect(byId.get(plainId)).not.toHaveProperty('has_owner_approval');

    for (const payload of [bobNode.received, stream.received, items]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain(QUOTE);
      expect(text).not.toContain('"owner_approval"');
      expect(text).not.toContain('hum_owner1');
    }
  });

  it('flags a delivery replayed to a node that connects after the send', async () => {
    const { ws, alice, bob } = await seed();
    const sent = await dm(alice.token, { to: 'bob', text: 'offline merge', owner_approval: approval() });
    const messageId = ((await sent.json()) as { data: { id: string } }).data.id;
    await stack.settle();

    const { sock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    await stack.settle();
    const frame = deliverFramesOfType(sock, 'dm.received').find((f) => f.msg_id === messageId);
    expect(frame).toBeDefined();
    const data = (frame!.payload as { data: Record<string, unknown> & { message: Record<string, unknown> } }).data;
    expect(data.message.has_owner_approval).toBe(true);
    expect(JSON.stringify(sock.received)).not.toContain(QUOTE);
  });

  it('treats a different approval under the same Idempotency-Key as a conflict', async () => {
    const { alice } = await seed();
    const key = { 'idempotency-key': 'owner-approval-key-1' };
    const first = await dm(alice.token, { to: 'bob', text: 'merge', owner_approval: approval() }, key);
    expect(first.status).toBe(201);
    const replay = await dm(alice.token, { to: 'bob', text: 'merge', owner_approval: approval() }, key);
    expect(replay.status).toBe(201);
    const widened = await dm(alice.token, { to: 'bob', text: 'merge', owner_approval: {
      ...approval(), actions: [{ class: 'deploy', target: 'svc:prod' }],
    } }, key);
    expect(widened.status).toBe(409);
  });
});
