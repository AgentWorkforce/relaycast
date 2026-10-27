import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, type TestStack } from './harness.js';

describe('workspace creation attribution', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack?.close());

  async function currentWorkspace(workspaceKey: string) {
    const response = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ data: Record<string, unknown> }>;
  }

  it('persists declared provenance, caller identity, and explicit internal classification', async () => {
    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relaycast-origin-client': 'agent-relay-ci',
        'x-relaycast-origin-actor': 'agent-relay-cli/cli',
        'x-agent-relay-user-id': 'usr_internal',
        'x-agent-relay-machine-id': 'machine_ci_01',
        'x-agent-relay-org-id': 'org_agentworkforce',
        'x-agent-relay-org-slug': 'agentworkforce',
      },
      body: JSON.stringify({
        name: 'ci-attributed',
        provenance: {
          source: 'ci',
          origin_id: 'github:AgentWorkforce/relay/actions/runs/123',
          classification: 'internal',
        },
      }),
    });

    expect(response.status).toBe(201);
    const created = await response.json() as { data: { api_key: string } };
    const workspace = (await currentWorkspace(created.data.api_key)).data;

    expect(workspace).toMatchObject({
      usage_classification: 'internal',
      classification_source: 'creator',
      classification_reason: 'creator_declared',
      provenance: {
        source: 'ci',
        origin_id: 'github:AgentWorkforce/relay/actions/runs/123',
        classification: 'internal',
        source_basis: 'declared',
        origin_actor: 'agent-relay-cli/cli',
        actor_user_id: 'usr_internal',
        actor_machine_id: 'machine_ci_01',
        actor_org_id: 'org_agentworkforce',
        actor_org_slug: 'agentworkforce',
      },
    });
    expect(workspace.classified_at).toEqual(expect.any(String));
  });

  it('derives SDK source from existing origin headers while leaving classification unknown', async () => {
    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relaycast-origin-client': '@relaycast/sdk-python',
      },
      body: JSON.stringify({ name: 'sdk-attributed' }),
    });

    expect(response.status).toBe(201);
    const created = await response.json() as { data: { api_key: string } };
    const workspace = (await currentWorkspace(created.data.api_key)).data;
    expect(workspace).toMatchObject({
      usage_classification: 'unknown',
      classification_source: 'unclassified',
      classification_reason: null,
      classified_at: null,
      provenance: {
        source: 'sdk',
        classification: 'unknown',
        source_basis: 'origin_client',
      },
    });
  });

  it('rejects malformed origin identifiers instead of recording misleading provenance', async () => {
    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-provenance',
        provenance: { source: 'ci', origin_id: 'run id with spaces' },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('rejects declared provenance that omits its required source', async () => {
    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'missing-provenance-source',
        provenance: { classification: 'internal' },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('requires classification provenance at the database boundary', async () => {
    const response = await stack.app.request('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'classification-constraint' }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as { data: { workspace_id: string } };
    const sqlite = stack.runtime.handle.sqlite;

    expect(() => sqlite.prepare(`
      UPDATE workspaces
      SET usage_classification = 'internal'
      WHERE id = ?
    `).run(created.data.workspace_id)).toThrow(/workspaces_usage_classification_source_check/);

    expect(() => sqlite.prepare(`
      UPDATE workspaces
      SET classification_source = 'operator'
      WHERE id = ?
    `).run(created.data.workspace_id)).toThrow(/workspaces_usage_classification_source_check/);

    expect(() => sqlite.prepare(`
      UPDATE workspaces
      SET usage_classification = 'external', classification_source = 'operator'
      WHERE id = ?
    `).run(created.data.workspace_id)).not.toThrow();
  });
});
