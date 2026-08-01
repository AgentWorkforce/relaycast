import { describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, type TestStack } from '../../__tests__/conformance/harness.js';

interface DirectoryAgentResponse {
  slug: string;
  name: string;
  description: string | null;
  endpoint_url: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  skills: Array<{ name: string; metadata: Record<string, unknown> }>;
}

async function createOasfAgent(stack: TestStack, workspaceKey: string, overrides: Record<string, unknown> = {}) {
  return stack.app.request('/v1/directory/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify({
      oasf: {
        schema_version: '1.1.0',
        name: 'Billing Agent',
        description: 'Handles billing lookups',
        version: '1.0.0',
        authors: ['acme-corp'],
        skills: [{ name: 'refund-lookup', uid: 71601 }],
        domains: [{ name: 'finance' }],
        locators: [
          { type: 'url', urls: ['https://partner-billing-agent.example.com'] },
          { type: 'container_image', urls: ['https://registry.example.com/billing:latest'] },
        ],
      },
      ...overrides,
    }),
  });
}

describe('POST /v1/directory/agents with an OASF record', () => {
  it('imports an OASF record into the native directory shape', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-import-ws');

    const res = await createOasfAgent(stack, ws.workspaceKey);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { data: DirectoryAgentResponse };
    expect(body.data.name).toBe('Billing Agent');
    expect(body.data.description).toBe('Handles billing lookups');
    // Only the url-typed locator becomes endpoint_url — never the container image.
    expect(body.data.endpoint_url).toBe('https://partner-billing-agent.example.com');
    expect(body.data.tags).toEqual(['finance']);
    expect(body.data.skills).toEqual([
      expect.objectContaining({ name: 'refund-lookup', metadata: { oasf_uid: 71601 } }),
    ]);

    stack.close();
  });

  it('applies slug/source_agent_name/status overrides alongside oasf', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-override-ws');

    const res = await createOasfAgent(stack, ws.workspaceKey, { slug: 'custom-slug', status: 'inactive' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: DirectoryAgentResponse & { status: string; slug: string } };
    expect(body.data.slug).toBe('custom-slug');
    expect(body.data.status).toBe('inactive');

    stack.close();
  });

  it('rejects a body mixing oasf with flat fields instead of silently dropping one side', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-ambiguous-ws');

    const res = await stack.app.request('/v1/directory/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        name: 'Should Not Win',
        oasf: {
          schema_version: '1.1.0',
          name: 'Billing Agent',
          description: 'Handles billing lookups',
          version: '1.0.0',
          authors: [],
          skills: [],
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);

    stack.close();
  });

  it('rejects an oasf record missing required fields', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-invalid-ws');

    const res = await stack.app.request('/v1/directory/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ oasf: { name: 'Incomplete' } }),
    });

    expect(res.status).toBe(400);

    stack.close();
  });

  it('rejects a non-URL locator entry rather than storing a malformed endpoint_url', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-bad-locator-ws');

    const res = await stack.app.request('/v1/directory/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        oasf: {
          schema_version: '1.1.0',
          name: 'Billing Agent',
          description: 'Handles billing lookups',
          version: '1.0.0',
          authors: [],
          skills: [],
          locators: [{ type: 'url', urls: ['not-a-url'] }],
        },
      }),
    });

    expect(res.status).toBe(400);

    stack.close();
  });
});

describe('GET /v1/directory/agents(/:slug)?format=oasf', () => {
  it('exports an OASF-imported agent with its extras round-tripped', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-export-ws');

    await createOasfAgent(stack, ws.workspaceKey);

    const res = await stack.app.request('/v1/directory/agents/billing-agent?format=oasf', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.schema_version).toBe('1.1.0');
    expect(body.data.name).toBe('Billing Agent');
    expect(body.data.authors).toEqual(['acme-corp']);
    expect(body.data.skills).toEqual([{ name: 'refund-lookup', uid: 71601 }]);
    expect(body.data.domains).toEqual([{ name: 'finance' }]);
    expect(body.data.locators).toEqual([
      { type: 'url', urls: ['https://partner-billing-agent.example.com'] },
      { type: 'container_image', urls: ['https://registry.example.com/billing:latest'] },
    ]);

    stack.close();
  });

  it('exports a natively-created agent as a derived, valid record', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-native-export-ws');

    const created = await stack.app.request('/v1/directory/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'Native Agent', endpoint_url: 'https://native.example.com', tags: ['support'] }),
    });
    expect(created.status).toBe(201);

    const res = await stack.app.request('/v1/directory/agents/native-agent?format=oasf', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe('Native Agent');
    expect(body.data.authors).toEqual(['Native Agent']);
    expect(body.data.domains).toEqual([{ name: 'support' }]);
    expect(body.data.locators).toEqual([{ type: 'url', urls: ['https://native.example.com'] }]);

    stack.close();
  });

  it('exports the list endpoint as an array of records', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-list-export-ws');

    await createOasfAgent(stack, ws.workspaceKey);

    const res = await stack.app.request('/v1/directory/agents?format=oasf', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].schema_version).toBe('1.1.0');

    stack.close();
  });

  it('rejects an unrecognized format value', async () => {
    const stack = makeNodeStack();
    const ws = await createWorkspace(stack.app, 'oasf-bad-format-ws');

    const res = await stack.app.request('/v1/directory/agents?format=xml', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(400);

    stack.close();
  });
});
