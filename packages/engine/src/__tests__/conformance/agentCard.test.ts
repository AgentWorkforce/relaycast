import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AgentCardSchema } from '@relaycast/types';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { agents } from '../../db/tables.js';

const CARD = {
  description: 'Operates AWS infrastructure: cost reports, drift checks and safe rollouts.',
  documentation_url: 'https://docs.example/infra-ops',
  tags: ['infra', 'aws'],
  updated_at: '2026-11-13T09:00:00.000Z',
  version: '2',
};

const SKILLS = [
  {
    id: 'cost-report',
    name: 'Cost report',
    description: 'Summarise AWS spend by service.',
    tags: ['aws', 'cost'],
    examples: ['What did we spend on EC2 last week?'],
  },
  { name: 'Drift check', description: 'Compare live stacks with their templates.' },
];

describe('agent cards', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  function send(method: string, path: string, key: string, body?: unknown) {
    return stack.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function getCard(key: string, name: string) {
    const res = await send('GET', `/v1/agents/${encodeURIComponent(name)}/card`, key);
    return { status: res.status, body: await res.json() as { ok: boolean; data: Record<string, unknown> } };
  }

  async function storedMetadata(workspaceId: string, name: string) {
    const [row] = await stack.runtime.deps.db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, name)));
    return row?.metadata as Record<string, unknown>;
  }

  it('returns the A2A card built from metadata.card and metadata.skills', async () => {
    const ws = await createWorkspace(stack.app, 'card-route');
    const created = await send('POST', '/v1/agents', ws.workspaceKey, {
      name: 'infra-ops',
      persona: 'Infra persona',
      metadata: { card: CARD, owner_name: 'Khaliq', source: 'hosted' },
      skills: SKILLS,
    });
    expect(created.status).toBe(201);

    const { status, body } = await getCard(ws.workspaceKey, 'infra-ops');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const card = body.data;
    expect(AgentCardSchema.parse(card)).toEqual(card);
    expect(card).toEqual({
      protocolVersion: '0.3.0',
      name: 'infra-ops',
      description: CARD.description,
      url: 'http://localhost/a2a/rpc',
      preferredTransport: 'JSONRPC',
      version: '2',
      provider: { organization: 'card-route', url: 'https://agentrelay.com' },
      documentationUrl: 'https://docs.example/infra-ops',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [
        {
          id: 'cost-report',
          name: 'Cost report',
          description: 'Summarise AWS spend by service.',
          tags: ['aws', 'cost'],
          examples: ['What did we spend on EC2 last week?'],
        },
        {
          id: 'drift-check',
          name: 'Drift check',
          description: 'Compare live stacks with their templates.',
          tags: [],
        },
      ],
      'x-agent-relay': {
        address: 'infra-ops@direct',
        kind: 'agent',
        owner: 'Khaliq',
        where: 'direct',
        status: 'live',
        tags: ['infra', 'aws'],
        cardUpdatedAt: '2026-11-13T09:00:00.000Z',
        hasCard: true,
      },
    });
  });

  it('returns a minimal card for an agent with no card and no skills', async () => {
    const ws = await createWorkspace(stack.app, 'card-minimal');
    await send('POST', '/v1/agents', ws.workspaceKey, { name: 'plain', persona: 'Writes release notes.' });

    const { status, body } = await getCard(ws.workspaceKey, 'plain');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      name: 'plain',
      description: 'Writes release notes.',
      version: '1',
      skills: [],
      'x-agent-relay': { kind: 'agent', status: 'live', tags: [], hasCard: false },
    });
    expect(body.data).not.toHaveProperty('documentationUrl');
    expect(body.data['x-agent-relay']).not.toHaveProperty('cardUpdatedAt');
  });

  it('404s for an unknown agent and for a released one', async () => {
    const ws = await createWorkspace(stack.app, 'card-missing');
    expect((await getCard(ws.workspaceKey, 'nobody')).status).toBe(404);

    const released = await registerAgent(stack.app, ws.workspaceKey, 'gone');
    const tombstone = `gone#released-${released.agentId}`;
    await stack.runtime.deps.db
      .update(agents)
      .set({ status: 'released', name: tombstone })
      .where(eq(agents.id, released.agentId));
    expect((await getCard(ws.workspaceKey, 'gone')).status).toBe(404);
    expect((await getCard(ws.workspaceKey, tombstone)).status).toBe(404);
  });

  it('rejects agent tokens, like the other agent detail reads', async () => {
    const ws = await createWorkspace(stack.app, 'card-auth');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'reader');
    const res = await send('GET', '/v1/agents/reader/card', agent.token);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  it('PATCH merges metadata keys, replaces skills, and keeps ownership fields', async () => {
    const ws = await createWorkspace(stack.app, 'card-patch');
    await send('POST', '/v1/agents', ws.workspaceKey, {
      name: 'bot',
      metadata: { source: 'hosted', owner_hash: 'abc', cloud_workspace_id: 'cw_1' },
      skills: [{ name: 'Old skill' }],
    });

    const patched = await send('PATCH', '/v1/agents/bot', ws.workspaceKey, {
      metadata: { card: CARD },
      skills: SKILLS,
    });
    expect(patched.status).toBe(200);

    expect(await storedMetadata(ws.workspaceId, 'bot')).toEqual({
      source: 'hosted',
      owner_hash: 'abc',
      cloud_workspace_id: 'cw_1',
      card: CARD,
      skills: SKILLS,
    });

    // A later PATCH of only `metadata.card` keeps the skills and other keys.
    const nextCard = { ...CARD, version: '3', updated_at: '2026-11-14T00:00:00Z' };
    expect((await send('PATCH', '/v1/agents/bot', ws.workspaceKey, { metadata: { card: nextCard } })).status).toBe(200);
    const after = await storedMetadata(ws.workspaceId, 'bot');
    expect(after).toMatchObject({ source: 'hosted', owner_hash: 'abc', cloud_workspace_id: 'cw_1', skills: SKILLS });
    expect(after.card).toEqual(nextCard);
  });

  it('enforces skill and card bounds on register and PATCH', async () => {
    const ws = await createWorkspace(stack.app, 'card-bounds');
    await registerAgent(stack.app, ws.workspaceKey, 'bounded');
    const patch = (body: unknown) => send('PATCH', '/v1/agents/bounded', ws.workspaceKey, body);

    expect((await patch({ skills: [{ name: 's', examples: ['a', 'b', 'c', 'd', 'e', 'f'] }] })).status).toBe(400);
    expect((await patch({ skills: [{ name: 's', examples: ['x'.repeat(201)] }] })).status).toBe(400);
    expect((await patch({ skills: [{ name: 'x'.repeat(81) }] })).status).toBe(400);
    expect((await patch({ skills: [{ name: 's', description: 'x'.repeat(501) }] })).status).toBe(400);
    expect((await patch({ skills: Array.from({ length: 21 }, (_, i) => ({ name: `s${i}` })) })).status).toBe(400);
    expect((await patch({ skills: [{ id: 'dup', name: 'a' }, { id: 'dup', name: 'b' }] })).status).toBe(400);
    expect((await patch({ metadata: { card: { ...CARD, description: 'x'.repeat(1001) } } })).status).toBe(400);
    expect((await patch({ metadata: { card: { ...CARD, documentation_url: 'http://docs.example' } } })).status).toBe(400);
    expect((await patch({ metadata: { card: { ...CARD, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) } } })).status).toBe(400);
    expect((await patch({ metadata: { card: { description: 'no version or timestamp' } } })).status).toBe(400);

    const registerTooMany = await send('POST', '/v1/agents', ws.workspaceKey, {
      name: 'too-many',
      skills: [{ name: 's', examples: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    });
    expect(registerTooMany.status).toBe(400);

    const ok = await patch({
      skills: [{ name: 's', examples: ['a', 'b', 'c', 'd', 'x'.repeat(200)] }],
      metadata: { card: CARD },
    });
    expect(ok.status).toBe(200);
  });
});
