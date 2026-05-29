import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';

describe('node adapter smoke', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  it('boots, migrates, and serves health', async () => {
    const res = await stack.app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('creates a workspace and registers an agent (await works on better-sqlite3)', async () => {
    const ws = await createWorkspace(stack.app, 'smoke-ws');
    expect(ws.workspaceKey).toMatch(/^rk_live_/);
    expect(ws.workspaceId).toBeTruthy();

    const agent = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    expect(agent.token).toMatch(/^at_live_/);
    expect(agent.agentId).toBeTruthy();
  });
});
