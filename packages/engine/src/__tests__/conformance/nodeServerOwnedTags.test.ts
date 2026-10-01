import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNode } from '../../engine/node.js';
import { DEFAULT_PROVIDER_NAME } from '../../engine/nodeProvider.js';
import type { EngineDb } from '../../ports/database.js';
import { createWorkspace, FakeSocket, makeNodeStack, type TestStack } from './harness.js';

// `cloud:*` tags are written by the control plane at enrollment and are the
// node's lifecycle identity. A broker re-registering over the node socket
// never learns them, so registration must keep them, and must not let the
// register frame add, change or remove them.
const ENROLLED_CLOUD_TAGS = [
  'cloud:sandbox-provider:daytona',
  'cloud:node-type:daytona-jit',
  'cloud:sandbox-id:sbx_ledger_1',
];

describe('fleet node server-owned cloud:* tags', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function enroll(workspaceKey: string, body: Record<string, unknown>) {
    const response = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: 'node_sandbox', name: 'sandbox-node', version: 'test-node', ...body }),
    });
    expect(response.ok).toBe(true);
  }

  async function readTags(workspaceKey: string): Promise<string[]> {
    const response = await stack.app.request('/v1/nodes?name=sandbox-node', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ tags: string[] }> };
    return body.data[0].tags;
  }

  async function register(workspaceId: string, id: string, fields: Record<string, unknown>) {
    const socket = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(workspaceId, 'node_sandbox', socket);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      id,
      type: 'node.register',
      name: 'sandbox-node',
      node_id: 'node_sandbox',
      capabilities: [],
      max_agents: 4,
      tags: [],
      version: 'test-node',
      resume_cursor: null,
      ...fields,
    }));
    const reply = socket.ofType('reply').at(-1) as { ok: boolean; data: { tags: string[] } };
    expect(reply.ok).toBe(true);
    await handle.handleClose();
    return reply.data.tags;
  }

  it('keeps enrolled cloud:* tags when a broker re-registers with no tags', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-empty');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: [...ENROLLED_CLOUD_TAGS, 'enrolled'] });

    // The broker sends `tags: []` because it never learned the enrollment tags.
    // Non-server-owned tags keep their existing semantics (the register value
    // wins, so `enrolled` goes); the cloud identity survives.
    expect(await register(workspace.workspaceId, 'register-empty', { tags: [] })).toEqual(ENROLLED_CLOUD_TAGS);
    expect(await readTags(workspace.workspaceKey)).toEqual(ENROLLED_CLOUD_TAGS);

    // And again on a later reconnect.
    expect(await register(workspace.workspaceId, 'register-empty-2', { tags: [] })).toEqual(ENROLLED_CLOUD_TAGS);
    expect(await readTags(workspace.workspaceKey)).toEqual(ENROLLED_CLOUD_TAGS);
  });

  it('ignores cloud:* tags in the register frame, so a broker cannot forge or change them', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-forged');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: ENROLLED_CLOUD_TAGS });

    const tags = await register(workspace.workspaceId, 'register-forged', {
      tags: [
        'linux',
        'cloud:sandbox-id:sbx_someone_else',
        'cloud:node-type:persistent',
        'cloud:relaycast-route:forged',
      ],
    });

    expect(tags).toEqual([...ENROLLED_CLOUD_TAGS, 'linux']);
    expect(await readTags(workspace.workspaceKey)).toEqual([...ENROLLED_CLOUD_TAGS, 'linux']);
  });

  it('does not let a register frame add cloud:* tags to a node enrolled without them', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-none');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: ['enrolled'] });

    const tags = await register(workspace.workspaceId, 'register-add-cloud', {
      tags: ['linux', 'cloud:sandbox-id:sbx_forged'],
    });

    expect(tags).toEqual(['linux']);
    expect(await readTags(workspace.workspaceKey)).toEqual(['linux']);
  });

  it('keeps non-cloud:* tags replaced by each register, alongside repo_keys', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-other');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: ENROLLED_CLOUD_TAGS });

    expect(await register(workspace.workspaceId, 'register-other-1', {
      // `cloudy` and `cloud-region:eu` share a stem with the reserved prefix but
      // are not `cloud:` tags, so they are ordinary broker tags.
      tags: ['linux', 'gpu', 'cloudy', 'cloud-region:eu', 'repo:forged/x'],
      repo_keys: ['AgentWorkforce/relaycast'],
    })).toEqual([
      ...ENROLLED_CLOUD_TAGS,
      'linux',
      'gpu',
      'cloudy',
      'cloud-region:eu',
      'repo:AgentWorkforce/relaycast',
    ]);

    // A later register replaces the broker's tags wholesale, as before.
    expect(await register(workspace.workspaceId, 'register-other-2', {
      tags: ['linux'],
      repo_keys: [],
    })).toEqual([...ENROLLED_CLOUD_TAGS, 'linux']);
    expect(await readTags(workspace.workspaceKey)).toEqual([...ENROLLED_CLOUD_TAGS, 'linux']);
  });

  it('leaves enrollment as the authority: a re-enroll changes cloud:* tags and register keeps the new set', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-reenroll');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: ENROLLED_CLOUD_TAGS });
    await register(workspace.workspaceId, 'register-before-reenroll', { tags: [] });

    const reEnrolled = ['cloud:sandbox-provider:daytona', 'cloud:sandbox-id:sbx_ledger_2'];
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: reEnrolled });

    expect(await register(workspace.workspaceId, 'register-after-reenroll', { tags: [] })).toEqual(reEnrolled);
    expect(await readTags(workspace.workspaceKey)).toEqual(reEnrolled);
  });

  it('leaves direct nodes preserving their enrollment tags, without accepting frame cloud:* tags', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-direct');
    await enroll(workspace.workspaceKey, {
      role: 'direct',
      max_agents: 1,
      tags: ['enrolled', 'cloud:sandbox-id:sbx_direct', 'repo:acme/stale'],
    });

    const tags = await register(workspace.workspaceId, 'register-direct', {
      max_agents: 1,
      tags: ['current', 'cloud:sandbox-id:sbx_forged'],
      repo_keys: ['AgentWorkforce/relaycast'],
    });

    // Unchanged direct-node behaviour: non-repo enrollment tags survive and the
    // repo advertisement is refreshed. The frame's cloud:* tag is ignored.
    expect(tags).toEqual(['enrolled', 'cloud:sandbox-id:sbx_direct', 'current', 'repo:AgentWorkforce/relaycast']);
    expect(await readTags(workspace.workspaceKey)).toEqual([
      'enrolled',
      'cloud:sandbox-id:sbx_direct',
      'current',
      'repo:AgentWorkforce/relaycast',
    ]);
  });

  it('keeps a re-enroll that commits after registration read the row but before it writes', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-race');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: ENROLLED_CLOUD_TAGS });
    const reEnrolled = ['cloud:sandbox-provider:daytona', 'cloud:sandbox-id:sbx_ledger_2'];

    // registerNode reads the row, then writes tags inside runAtomic. Land a
    // re-enroll in exactly that window: after the read, before the write
    // transaction opens. A merge computed from the earlier read would put
    // `sbx_ledger_1` back; the in-statement merge must keep `sbx_ledger_2`.
    const db = stack.runtime.deps.db as EngineDb & { withTransaction: <T>(fn: (tx: EngineDb) => Promise<T>) => Promise<T> };
    let reEnrolledMidRegister = false;
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'withTransaction') {
          return async <T>(fn: (tx: EngineDb) => Promise<T>): Promise<T> => {
            if (!reEnrolledMidRegister) {
              reEnrolledMidRegister = true;
              await enroll(workspace.workspaceKey, { max_agents: 4, tags: reEnrolled });
            }
            return target.withTransaction(fn);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await registerNode(racingDb, workspace.workspaceId, 'node_sandbox', {
      v: 1,
      id: 'register-race',
      type: 'node.register',
      name: 'sandbox-node',
      node_id: 'node_sandbox',
      capabilities: [],
      max_agents: 4,
      tags: ['linux'],
      version: 'test-node',
      resume_cursor: null,
    }, { name: DEFAULT_PROVIDER_NAME, instance_id: 'conn_race' });

    expect(reEnrolledMidRegister).toBe(true);
    expect(result.node.tags).toEqual([...reEnrolled, 'linux']);
    expect(await readTags(workspace.workspaceKey)).toEqual([...reEnrolled, 'linux']);
  });

  it('logs the cloud:* tags a register frame tried to set, and still registers', async () => {
    const workspace = await createWorkspace(stack.app, 'node-cloud-tags-warn');
    await enroll(workspace.workspaceKey, { max_agents: 4, tags: ENROLLED_CLOUD_TAGS });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const tags = await register(workspace.workspaceId, 'register-warn', {
        tags: ['linux', 'cloud:region:eu-west', 'cloud:region:eu-west', 'cloud:sandbox-id:sbx_forged'],
      });
      expect(tags).toEqual([...ENROLLED_CLOUD_TAGS, 'linux']);
      const ignored = warn.mock.calls.filter(([label]) => label === '[node.register] ignored server-owned tags');
      expect(ignored).toEqual([[
        '[node.register] ignored server-owned tags',
        {
          workspaceId: workspace.workspaceId,
          nodeId: 'node_sandbox',
          prefix: 'cloud:',
          tags: ['cloud:region:eu-west', 'cloud:sandbox-id:sbx_forged'],
        },
      ]]);

      warn.mockClear();
      await register(workspace.workspaceId, 'register-no-warn', { tags: ['linux', 'cloudy'] });
      expect(warn.mock.calls.filter(([label]) => label === '[node.register] ignored server-owned tags')).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
