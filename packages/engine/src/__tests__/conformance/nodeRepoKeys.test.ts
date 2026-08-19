import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';

describe('fleet node repository advertisements', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function enrollNode(workspaceKey: string) {
    const response = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_repos',
        name: 'repo-builder',
        max_agents: 4,
        tags: ['enrolled'],
        version: 'test-node',
      }),
    });
    expect(response.status).toBe(201);
  }

  async function readNode(workspaceKey: string) {
    const response = await stack.app.request('/v1/nodes?name=repo-builder', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<Record<string, unknown>> };
    return body.data[0];
  }

  it('derives repo tags only from repo_keys, replaces them on reconnect, and exposes readback', async () => {
    const workspace = await createWorkspace(stack.app, 'node-repo-keys');
    await enrollNode(workspace.workspaceKey);

    const firstSocket = new FakeSocket();
    const first = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', firstSocket);
    await first.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-repos-1',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'cwd:/Users/build', 'repo:relay', 'repo:acme/legacy'],
      repo_keys: ['AgentWorkforce/relaycast', 'acme/legacy'],
      version: 'test-node',
      resume_cursor: null,
    }));

    // `repo:relay` arrived only in `tags` and is dropped; `repo:acme/legacy` is
    // kept because `repo_keys` independently vouches for it, not because the
    // caller asked for it in `tags`.
    expect(firstSocket.ofType('reply').at(-1)).toMatchObject({
      ok: true,
      data: {
        tags: [
          'linux',
          'cwd:/Users/build',
          'repo:AgentWorkforce/relaycast',
          'repo:acme/legacy',
        ],
      },
    });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: [
        'linux',
        'cwd:/Users/build',
        'repo:AgentWorkforce/relaycast',
        'repo:acme/legacy',
      ],
    });

    await first.handleClose();
    const secondSocket = new FakeSocket();
    const second = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', secondSocket);
    await second.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-repos-2',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'gpu'],
      repo_keys: ['AgentWorkforce/relay'],
      version: 'test-node-v2',
      resume_cursor: null,
    }));

    expect(secondSocket.ofType('reply').at(-1)).toMatchObject({
      ok: true,
      data: { tags: ['linux', 'gpu', 'repo:AgentWorkforce/relay'] },
    });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: ['linux', 'gpu', 'repo:AgentWorkforce/relay'],
      version: 'test-node-v2',
    });
  });

  it('rejects spoofed path-shaped repo tags without changing persisted readback', async () => {
    const workspace = await createWorkspace(stack.app, 'node-unsafe-repo-keys');
    await enrollNode(workspace.workspaceKey);

    const unsafeEnrollment = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_repos',
        name: 'repo-builder',
        tags: ['repo:/srv/private-repo'],
      }),
    });
    expect(unsafeEnrollment.status).toBe(400);
    expect(await unsafeEnrollment.json()).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'invalid node body' },
    });

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);

    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-safe-repo',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux'],
      repo_keys: ['AgentWorkforce/relaycast'],
      version: 'test-node',
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-spoofed-repo',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'repo:/Users/alice/private-repo'],
      version: 'test-node',
    }));

    expect(socket.ofType('error').at(-1)).toMatchObject({ ok: false, code: 'invalid_message' });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: ['linux', 'repo:AgentWorkforce/relaycast'],
    });
  });

  it('preserves direct-node non-repo tags while refreshing its repo advertisement', async () => {
    const workspace = await createWorkspace(stack.app, 'direct-node-repo-keys');
    const enrollment = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspace.workspaceKey}` },
      body: JSON.stringify({
        node_id: 'node_repos',
        name: 'repo-builder',
        role: 'direct',
        max_agents: 1,
        tags: ['enrolled', 'repo:acme/stale'],
        version: 'test-node',
      }),
    });
    expect(enrollment.status).toBe(201);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-direct-repos',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 1,
      tags: ['current', 'repo:relay'],
      repo_keys: ['AgentWorkforce/relaycast'],
      version: 'test-node-v2',
    }));

    // `enrolled` survives, the stale `repo:acme/stale` enrollment tag is refreshed
    // away, and the self-asserted `repo:relay` tag does not reach the roster.
    expect(socket.ofType('reply').at(-1)).toMatchObject({
      ok: true,
      data: {
        tags: ['enrolled', 'current', 'repo:AgentWorkforce/relaycast'],
      },
    });
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      role: 'direct',
      tags: ['enrolled', 'current', 'repo:AgentWorkforce/relaycast'],
    });
  });

  it('does not let a forged repo tag make the node match a repository it never vouched for', async () => {
    const workspace = await createWorkspace(stack.app, 'node-forged-repo-tag');
    await enrollNode(workspace.workspaceKey);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-forged-repo',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      // `repo:forged/x` is a perfectly well-formed owner/name key, so schema
      // validation cannot catch it. Only repo_keys may source a repo tag.
      tags: ['linux', 'repo:forged/x'],
      repo_keys: ['AgentWorkforce/relaycast'],
      version: 'test-node',
      resume_cursor: null,
    }));

    const reply = socket.ofType('reply').at(-1) as { ok: boolean; data: { tags: string[] } };
    expect(reply.ok).toBe(true);
    expect(reply.data.tags).not.toContain('repo:forged/x');
    expect(reply.data.tags).toEqual(['linux', 'repo:AgentWorkforce/relaycast']);

    const row = await readNode(workspace.workspaceKey) as { tags: string[] };
    expect(row.tags).not.toContain('repo:forged/x');
    expect(row.tags).toEqual(['linux', 'repo:AgentWorkforce/relaycast']);
  });

  it('does not let repo tags override or merge with structured repo_keys', async () => {
    const workspace = await createWorkspace(stack.app, 'node-repo-tag-override');
    await enrollNode(workspace.workspaceKey);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-repo-override',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'repo:forged/one', 'repo:forged/two', 'repo:relay'],
      repo_keys: ['AgentWorkforce/relaycast'],
      version: 'test-node',
      resume_cursor: null,
    }));

    const row = await readNode(workspace.workspaceKey) as { tags: string[] };
    expect(row.tags.filter((tag) => tag.startsWith('repo:'))).toEqual(['repo:AgentWorkforce/relaycast']);
  });

  it('advertises no repository when repo_keys is present but empty, however many repo tags arrive', async () => {
    const workspace = await createWorkspace(stack.app, 'node-empty-repo-keys');
    await enrollNode(workspace.workspaceKey);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-empty-repo-keys',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'repo:forged/x', 'repo:relay'],
      // An explicit empty list is a node stating it serves no repository. It is
      // not an absent field, so it still suppresses caller-supplied repo tags.
      repo_keys: [],
      version: 'test-node',
      resume_cursor: null,
    }));

    const row = await readNode(workspace.workspaceKey) as { tags: string[] };
    expect(row.tags.filter((tag) => tag.startsWith('repo:'))).toEqual([]);
    expect(row.tags).toEqual(['linux']);
  });

  it('keeps non-repo tags round-tripping untouched', async () => {
    const workspace = await createWorkspace(stack.app, 'node-non-repo-tags');
    await enrollNode(workspace.workspaceKey);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-non-repo-tags',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'gpu', 'cwd:/Users/build', 'region:us-east-1', 'repository-cache'],
      repo_keys: ['AgentWorkforce/relaycast'],
      version: 'test-node',
      resume_cursor: null,
    }));

    // `repository-cache` starts with `repo` but not `repo:`, so it is an ordinary tag.
    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: ['linux', 'gpu', 'cwd:/Users/build', 'region:us-east-1', 'repository-cache', 'repo:AgentWorkforce/relaycast'],
    });
  });

  it('still honours repo tags from pre-repo_keys clients that omit the field entirely', async () => {
    const workspace = await createWorkspace(stack.app, 'node-legacy-repo-tags');
    await enrollNode(workspace.workspaceKey);

    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspace.workspaceId, 'node_repos', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'register-legacy-repo-tags',
      type: 'node.register',
      name: 'repo-builder',
      node_id: 'node_repos',
      capabilities: [],
      max_agents: 4,
      tags: ['linux', 'repo:relay', 'repo:AgentWorkforce/relaycast'],
      // No `repo_keys` field at all: a pre-repo_keys client. Its repo tags are
      // the only advertisement it can make, so they are preserved. This is the
      // documented residual trust in the legacy path - a client that omits
      // `repo_keys` is still taken at its word - and is why the broker should
      // send `repo_keys` (even `[]`) as soon as it supports the field.
      version: 'test-node',
      resume_cursor: null,
    }));

    expect(await readNode(workspace.workspaceKey)).toMatchObject({
      tags: ['linux', 'repo:relay', 'repo:AgentWorkforce/relaycast'],
    });
  });
});
