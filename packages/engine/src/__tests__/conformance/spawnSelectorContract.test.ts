/**
 * CROSS-REPO CONTRACT: the spawn node selector, as relied on by AgentWorkforce
 * Cloud hosted spawn.
 *
 * Cloud launches hosted agents by sending a spawn with `target_node: <name>`
 * and depends on these behaviours of `claimSpawnNode` / `chooseNodeForAction`
 * (engine/placement.ts) and the routes in front of them:
 *
 *   1. Node names are unique per workspace (`nodes_workspace_name_unique`).
 *   2. The selector trims `target_node` (and its `node` / `target` aliases).
 *   3. After trimming, the name matches stored node names exactly and
 *      case-sensitively, across nodes in every status, and a named target that
 *      is not live never falls back to another node.
 *
 * A failing test here means the change alters behaviour another repository
 * depends on: coordinate it with the AgentWorkforce Cloud hosted-spawn owners.
 * Do not edit these tests to make them pass.
 *
 * Lives in the conformance suite so it also runs under the PostgreSQL
 * conformance config (case sensitivity and the unique index on both backends).
 * Assertions pin error codes and node ids only, never message wording.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';
import { nodes } from '../../db/tables.js';
import type { EngineDb } from '../../ports/database.js';
import { chooseNodeForAction, claimSpawnNode } from '../../engine/placement.js';

const CAPABILITY = 'spawn:claude';
const SPAWN_INPUT = { cli: 'claude' } as const;

interface NodeSpec {
  id: string;
  name: string;
  status?: string;
  /** Fresh heartbeat + handlers live (only meaningful with status 'online'). */
  live?: boolean;
  capabilities?: string[];
  maxAgents?: number;
  activeAgents?: number;
}

async function addNode(db: EngineDb, workspaceId: string, spec: NodeSpec) {
  const live = spec.live ?? true;
  const [row] = await db.insert(nodes).values({
    id: spec.id,
    workspaceId,
    name: spec.name,
    tokenHash: `hash_${spec.id}`,
    role: 'broker',
    status: spec.status ?? 'online',
    handlersLive: live,
    capabilities: (spec.capabilities ?? [CAPABILITY]).map((name) => ({ name })) as never,
    maxAgents: spec.maxAgents ?? 0,
    activeAgents: spec.activeAgents ?? 0,
    lastHeartbeatAt: live ? new Date() : new Date(Date.now() - 300_000),
  }).returning();
  return row;
}

describe('spawn selector contract (AgentWorkforce Cloud hosted spawn)', () => {
  let stack: TestStack;
  let db: EngineDb;
  let workspaceId: string;
  let workspaceKey: string;

  beforeEach(async () => {
    stack = makeNodeStack();
    db = stack.runtime.deps.db;
    const ws = await createWorkspace(stack.app, 'spawn-selector-contract');
    workspaceId = ws.workspaceId;
    workspaceKey = ws.workspaceKey;
  });
  afterEach(async () => { await stack?.close(); });

  /** Both public selector functions, so each resolution site is covered. */
  const selectors = {
    claimSpawnNode: (input: Record<string, unknown>, extra: { excludeNodeIds?: string[] } = {}) =>
      claimSpawnNode(db, workspaceId, { actionName: 'spawn', input: { ...SPAWN_INPUT, ...input }, ...extra }),
    chooseNodeForAction: (input: Record<string, unknown>, extra: { excludeNodeIds?: string[] } = {}) =>
      chooseNodeForAction(db, workspaceId, { actionName: 'spawn', input: { ...SPAWN_INPUT, ...input }, ...extra }),
  } as const;
  const selectorNames = Object.keys(selectors) as (keyof typeof selectors)[];

  const enroll = (body: Record<string, unknown>) => stack.app.request('/v1/nodes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
    body: JSON.stringify(body),
  });

  describe('1. node names are unique per workspace', () => {
    it('enrollment rejects a second node with the same name in the same workspace', async () => {
      const first = await enroll({ node_id: 'node_alpha', name: 'alpha' });
      expect(first.status).toBe(201);
      const otherId = await enroll({ node_id: 'node_alpha_two', name: 'alpha' });
      expect(otherId.status).toBe(409);
      expect(await otherId.json()).toMatchObject({ ok: false, error: { code: 'node_name_conflict' } });
      // Without a node_id the name resolves to the existing row, which cannot be
      // taken over without its token: still no second node.
      const noId = await enroll({ name: 'alpha' });
      expect(noId.status).toBe(409);
      expect(await noId.json()).toMatchObject({ ok: false, error: { code: 'node_token_proof_required' } });
      const rows = await db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
      expect(rows.map((row) => row.id)).toEqual(['node_alpha']);
    });

    it('the database unique index rejects a duplicate (workspace, name) row', async () => {
      await addNode(db, workspaceId, { id: 'node_alpha', name: 'alpha' });
      await expect(addNode(db, workspaceId, { id: 'node_alpha_dup', name: 'alpha' })).rejects.toThrow();
      const rows = await db.select().from(nodes).where(eq(nodes.workspaceId, workspaceId));
      expect(rows.map((row) => row.id)).toEqual(['node_alpha']);
    });

    it('the same name in a different workspace is allowed and each workspace selects its own node', async () => {
      const other = await createWorkspace(stack.app, 'spawn-selector-contract-other');
      await addNode(db, workspaceId, { id: 'node_alpha_a', name: 'alpha' });
      await addNode(db, other.workspaceId, { id: 'node_alpha_b', name: 'alpha' });
      const res = await stack.app.request('/v1/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${other.workspaceKey}` },
        body: JSON.stringify({ node_id: 'node_beta_b', name: 'beta' }),
      });
      expect(res.status).toBe(201);
      expect((await enroll({ node_id: 'node_beta_a', name: 'beta' })).status).toBe(201);
      expect((await selectors.chooseNodeForAction({ target_node: 'alpha' })).node.id).toBe('node_alpha_a');
      expect((await chooseNodeForAction(db, other.workspaceId, {
        actionName: 'spawn', input: { ...SPAWN_INPUT, target_node: 'alpha' },
      })).node.id).toBe('node_alpha_b');
    });

    it('names differing only in case are different nodes', async () => {
      expect((await enroll({ node_id: 'node_lower', name: 'alpha' })).status).toBe(201);
      expect((await enroll({ node_id: 'node_upper', name: 'Alpha' })).status).toBe(201);
      await expect(addNode(db, workspaceId, { id: 'node_caps', name: 'ALPHA' })).resolves.toBeDefined();
    });

    it('enrollment stores a name with surrounding whitespace verbatim (no trim on write)', async () => {
      const padded = await enroll({ node_id: 'node_padded', name: '  alpha  ' });
      expect(padded.status).toBe(201);
      const [row] = await db.select().from(nodes).where(eq(nodes.id, 'node_padded'));
      expect(row.name).toBe('  alpha  ');
      // It does not collide with the unpadded name either.
      expect((await enroll({ node_id: 'node_plain', name: 'alpha' })).status).toBe(201);
    });
  });

  describe.each(selectorNames)('2. trimming (%s)', (selector) => {
    const select = (input: Record<string, unknown>) => selectors[selector](input);

    beforeEach(async () => {
      await addNode(db, workspaceId, { id: 'node_alpha', name: 'alpha' });
      await addNode(db, workspaceId, { id: 'node_decoy', name: 'decoy' });
    });

    it('a padded target_node selects the node stored under the trimmed name', async () => {
      for (const target of ['  alpha  ', '\talpha\n', 'alpha ']) {
        expect((await select({ target_node: target })).node.id).toBe('node_alpha');
      }
    });

    it('the node and target aliases are trimmed the same way', async () => {
      expect((await select({ node: '  alpha ' })).node.id).toBe('node_alpha');
      expect((await select({ target: ' alpha  ' })).node.id).toBe('node_alpha');
    });

    it('target_node takes precedence over node, which takes precedence over target', async () => {
      expect((await select({ target_node: 'alpha', node: 'decoy', target: 'decoy' })).node.id).toBe('node_alpha');
      expect((await select({ node: 'alpha', target: 'decoy' })).node.id).toBe('node_alpha');
    });

    it('a whitespace-only or empty target_node means no target: automatic placement', async () => {
      // Make the automatic choice deterministic: only the decoy is eligible.
      await db.update(nodes).set({ status: 'offline', handlersLive: false }).where(eq(nodes.id, 'node_alpha'));
      for (const target of ['', '   ', '\t\n']) {
        expect((await select({ target_node: target })).node.id).toBe('node_decoy');
      }
      // A blank target_node is not nullish, so it also hides a `node` alias.
      expect((await select({ target_node: '   ', node: 'alpha' })).node.id).toBe('node_decoy');
    });

    it('a non-string target_node means no target: automatic placement', async () => {
      await db.update(nodes).set({ status: 'offline', handlersLive: false }).where(eq(nodes.id, 'node_alpha'));
      expect((await select({ target_node: 42 })).node.id).toBe('node_decoy');
    });

    it('a node stored with surrounding whitespace is not reachable by name', async () => {
      await addNode(db, workspaceId, { id: 'node_padded', name: '  padded  ' });
      await expect(select({ target_node: '  padded  ' })).rejects.toMatchObject({ code: 'node_not_found' });
      await expect(select({ target_node: 'padded' })).rejects.toMatchObject({ code: 'node_not_found' });
    });
  });

  describe.each(selectorNames)('3. exact, case-sensitive match (%s)', (selector) => {
    const select = (input: Record<string, unknown>) => selectors[selector](input);

    it('a different case does not select the node and does not fall back', async () => {
      await addNode(db, workspaceId, { id: 'node_alpha', name: 'alpha' });
      for (const target of ['Alpha', 'ALPHA', ' Alpha ']) {
        await expect(select({ target_node: target })).rejects.toMatchObject({ code: 'node_not_found', status: 404 });
      }
    });

    it('names differing only in case each select their own node', async () => {
      await addNode(db, workspaceId, { id: 'node_lower', name: 'alpha' });
      await addNode(db, workspaceId, { id: 'node_upper', name: 'Alpha' });
      expect((await select({ target_node: 'alpha' })).node.id).toBe('node_lower');
      expect((await select({ target_node: 'Alpha' })).node.id).toBe('node_upper');
      expect((await select({ target_node: '  Alpha  ' })).node.id).toBe('node_upper');
    });

    it('a prefix, suffix, substring, superstring or #-prefixed name does not match', async () => {
      await addNode(db, workspaceId, { id: 'node_alpha', name: 'alpha-node' });
      for (const target of ['alpha', 'node', 'pha-no', 'alpha-node-2', 'alpha-node%', 'alpha_node', '#alpha-node']) {
        await expect(select({ target_node: target })).rejects.toMatchObject({ code: 'node_not_found' });
      }
      expect((await select({ target_node: 'alpha-node' })).node.id).toBe('node_alpha');
    });

    it('an unknown name fails with node_not_found even when another node is live', async () => {
      await addNode(db, workspaceId, { id: 'node_decoy', name: 'decoy' });
      await expect(select({ target_node: 'ghost' })).rejects.toMatchObject({ code: 'node_not_found', status: 404 });
      await expect(select({ node: 'ghost' })).rejects.toMatchObject({ code: 'node_not_found' });
      await expect(select({ target: 'ghost' })).rejects.toMatchObject({ code: 'node_not_found' });
    });
  });

  describe.each(selectorNames)('3. every node state, no fallback (%s)', (selector) => {
    const select = (input: Record<string, unknown>, extra?: { excludeNodeIds?: string[] }) =>
      selectors[selector](input, extra);

    beforeEach(async () => {
      // A live, idle, capable decoy: any fallback would land here.
      await addNode(db, workspaceId, { id: 'node_decoy', name: 'decoy' });
    });

    it('online and live: selected and not queued', async () => {
      await addNode(db, workspaceId, { id: 'node_target', name: 'target' });
      const result = await select({ target_node: 'target' });
      expect(result).toMatchObject({ node: { id: 'node_target' }, capability: CAPABILITY, queued: false });
    });

    it.each([
      ['offline', { status: 'offline', live: false }],
      ['online with a stale heartbeat', { status: 'online', live: false }],
      ['an arbitrary status value', { status: 'draining', live: true }],
    ])('%s: the named node is still selected, queued, never another node', async (_label, state) => {
      await addNode(db, workspaceId, { id: 'node_target', name: 'target', ...state });
      const result = await select({ target_node: '  target ' });
      expect(result).toMatchObject({ node: { id: 'node_target' }, queued: true });
      // A queued placement holds no reservation on the named node.
      const [row] = await db.select().from(nodes).where(eq(nodes.id, 'node_target'));
      expect(row.reservedAgents ?? 0).toBe(0);
      const [decoy] = await db.select().from(nodes).where(eq(nodes.id, 'node_decoy'));
      expect(decoy.reservedAgents ?? 0).toBe(0);
    });

    it('a named node without the requested capability fails with capability_mismatch', async () => {
      await addNode(db, workspaceId, { id: 'node_target', name: 'target', capabilities: ['spawn:codex'] });
      await expect(select({ target_node: 'target' })).rejects.toMatchObject({ code: 'capability_mismatch', status: 409 });
      await db.update(nodes).set({ status: 'offline', handlersLive: false }).where(eq(nodes.id, 'node_target'));
      await expect(select({ target_node: 'target' })).rejects.toMatchObject({ code: 'capability_mismatch' });
    });

    it('a named node excluded by a retry fails with handler_unavailable', async () => {
      await addNode(db, workspaceId, { id: 'node_target', name: 'target' });
      await expect(select({ target_node: 'target' }, { excludeNodeIds: ['node_target'] }))
        .rejects.toMatchObject({ code: 'handler_unavailable', status: 503 });
    });
  });

  describe('3. capacity on a live named node', () => {
    beforeEach(async () => {
      await addNode(db, workspaceId, { id: 'node_decoy', name: 'decoy' });
      await addNode(db, workspaceId, { id: 'node_full', name: 'full', maxAgents: 1, activeAgents: 1 });
    });

    it('claimSpawnNode: a full live named node fails with handler_unavailable, no fallback', async () => {
      await expect(selectors.claimSpawnNode({ target_node: 'full' }))
        .rejects.toMatchObject({ code: 'handler_unavailable', status: 503 });
      const [decoy] = await db.select().from(nodes).where(eq(nodes.id, 'node_decoy'));
      expect(decoy.reservedAgents ?? 0).toBe(0);
    });

    it('chooseNodeForAction: a full live named node is still selected (no capacity check)', async () => {
      expect(await selectors.chooseNodeForAction({ target_node: 'full' }))
        .toMatchObject({ node: { id: 'node_full' }, queued: false });
    });

    it('claimSpawnNode reserves capacity on the named live node only', async () => {
      await addNode(db, workspaceId, { id: 'node_target', name: 'target' });
      const result = await selectors.claimSpawnNode({ target_node: 'target' });
      expect(result).toMatchObject({ node: { id: 'node_target', reservedAgents: 1 }, queued: false });
      const [decoy] = await db.select().from(nodes).where(eq(nodes.id, 'node_decoy'));
      expect(decoy.reservedAgents ?? 0).toBe(0);
    });
  });

  describe('claimSpawnNode with a preferred node id (node-addressed and capacity-direct spawn)', () => {
    beforeEach(async () => {
      await addNode(db, workspaceId, { id: 'node_alpha', name: 'alpha' });
    });

    it('a padded target_node naming the preferred node is accepted', async () => {
      const result = await claimSpawnNode(db, workspaceId, {
        actionName: 'spawn', input: { ...SPAWN_INPUT, target_node: '  alpha  ' }, preferredNodeId: 'node_alpha',
      });
      expect(result.node.id).toBe('node_alpha');
    });

    it('a target_node in a different case fails with node_target_mismatch', async () => {
      await expect(claimSpawnNode(db, workspaceId, {
        actionName: 'spawn', input: { ...SPAWN_INPUT, target_node: 'Alpha' }, preferredNodeId: 'node_alpha',
      })).rejects.toMatchObject({ code: 'node_target_mismatch', status: 409 });
    });
  });

  describe('through POST /v1/actions/spawn/invoke', () => {
    let callerToken: string;
    beforeEach(async () => {
      callerToken = (await registerAgent(stack.app, workspaceKey, 'launcher')).token;
      await addNode(db, workspaceId, { id: 'node_decoy', name: 'decoy' });
      await addNode(db, workspaceId, { id: 'node_target', name: 'target', status: 'offline', live: false });
    });
    const spawn = (input: Record<string, unknown>) => stack.app.request('/v1/actions/spawn/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${callerToken}` },
      body: JSON.stringify({ input: { cli: 'claude', ...input } }),
    });

    it('a padded name of an offline node is accepted pending on that node, not another', async () => {
      const res = await spawn({ name: 'worker-offline', target_node: '  target  ' });
      expect(res.status).toBe(201);
      const { data } = await res.json() as { data: Record<string, unknown> };
      expect(data).toMatchObject({ handler_node_id: 'node_target', status: 'pending' });
      expect(data.dispatched_node_id).not.toBe('node_decoy');
      await stack.settle();
    });

    it('an offline named node with verify_ready fails with spawn_target_unavailable', async () => {
      const res = await spawn({ name: 'worker-verified', target_node: 'target', verify_ready: true });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: 'spawn_target_unavailable' } });
    });

    it('an unknown or wrong-case name fails with node_not_found', async () => {
      for (const [i, target_node] of ['ghost', 'Target', 'targ'].entries()) {
        const res = await spawn({ name: `worker-missing-${i}`, target_node });
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: 'node_not_found' } });
      }
    });
  });

  describe('through POST /v1/actions/spawn/strict-invoke (exact id + name, no trim)', () => {
    let callerToken: string;
    beforeEach(async () => {
      callerToken = (await registerAgent(stack.app, workspaceKey, 'launcher')).token;
      await addNode(db, workspaceId, { id: 'node_alpha', name: 'alpha' });
    });
    const strict = (targetNode: string, key: string) => {
      const logical = {
        schema: 'relay.spawn.invoke.logical/1', target_node_id: 'node_alpha', target_node: targetNode,
        name: 'worker', cli: 'claude', task: 'review', directory: '/repo', verify_ready: false,
      };
      const input = {
        spawn_contract: 'relay.spawn.invoke.logical/1', target_node_id: 'node_alpha', target_node: targetNode,
        name: 'worker', cli: 'claude', task: 'review', worker_cwd: '/repo', verify_ready: false,
        logical_request: logical,
      };
      return stack.app.request('/v1/actions/spawn/strict-invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${callerToken}`, 'Idempotency-Key': key },
        body: JSON.stringify({ input }),
      });
    };

    it('a padded or wrong-case target_node fails with node_target_mismatch', async () => {
      for (const [i, target] of ['  alpha  ', 'Alpha'].entries()) {
        const res = await strict(target, `strict-mismatch-${i}`);
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: 'node_target_mismatch' } });
      }
    });
  });
});
