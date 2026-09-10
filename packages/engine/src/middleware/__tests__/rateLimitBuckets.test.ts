import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EntitlementsProvider, PlanLimits, Workspace } from '../../ports/index.js';
import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from '../../__tests__/conformance/harness.js';

// A very low per-minute ceiling makes bucket draining a handful of requests
// instead of hundreds. Every non-rate limit stays generous so it does not
// masquerade as the 429 we're asserting.
const LOW_RATE_LIMIT = 3;
const LIMITS: PlanLimits = {
  messages: 1_000_000,
  agents: 1000,
  file_bytes: Infinity,
  api_calls: 1_000_000,
  rate_per_min: LOW_RATE_LIMIT,
};
class LowRateEntitlements implements EntitlementsProvider {
  async getLimits(_workspace: Workspace): Promise<PlanLimits> {
    return LIMITS;
  }
  async getUsage(): Promise<number> {
    return 0;
  }
}

describe('rate limit route buckets', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ entitlements: new LowRateEntitlements() }); });
  afterEach(async () => { await stack.close(); });

  // Prod incident: /v1/agent/node-token was un-keyed in ROUTE_MULTIPLIERS, so
  // every request drew from the workspace `global` bucket. 1,299 x 429 on
  // node-token in ~3.5 minutes 429'd /v1/inbox, /v1/dm, /v1/observer-tokens,
  // and /v1/channels/dev/messages in the same window. Assert the endpoint
  // owns its own bucket so a burst on it does not throttle unrelated traffic.
  it('does not 429 /v1/inbox after draining POST /v1/agent/node-token in the same workspace', async () => {
    const ws = await createWorkspace(stack.app, 'node-token-bucket');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'burst-agent');

    // Drain node-token past LOW_RATE_LIMIT so the fresh-request path is 429.
    // The exact 429 count is not the point — we care that _some_ 429s appear
    // on this endpoint before we check for spillover on a different one.
    const nodeTokenStatuses: number[] = [];
    for (let i = 0; i < LOW_RATE_LIMIT + 3; i++) {
      const res = await stack.app.request('/v1/agent/node-token', {
        method: 'POST',
        headers: { authorization: `Bearer ${agent.token}` },
      });
      nodeTokenStatuses.push(res.status);
    }
    expect(nodeTokenStatuses.filter((s) => s === 429).length).toBeGreaterThan(0);

    const inbox = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(inbox.status).not.toBe(429);
  });

  // Same shape for observer-token minting: enrollment/demo bursts here must
  // not throttle every other endpoint in the workspace.
  it('does not 429 /v1/inbox after draining POST /v1/observer-tokens in the same workspace', async () => {
    const ws = await createWorkspace(stack.app, 'observer-token-bucket');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'observer-agent');

    const observerStatuses: number[] = [];
    for (let i = 0; i < LOW_RATE_LIMIT + 3; i++) {
      const res = await stack.app.request('/v1/observer-tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ws.workspaceKey}`,
        },
        body: JSON.stringify({ scope: {} }),
      });
      observerStatuses.push(res.status);
    }
    expect(observerStatuses.filter((s) => s === 429).length).toBeGreaterThan(0);

    const inbox = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(inbox.status).not.toBe(429);
  });
});
