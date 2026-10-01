import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { workspaces } from '../../db/schema.js';
import type { TelemetryEvent } from '../../ports/telemetry.js';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

/**
 * Emitters without an authenticated workspace in context load the workspace
 * row themselves, so their events carry the same PostHog groups as
 * authenticated routes.
 */
describe('server telemetry attribution without workspace auth', () => {
  let stack: TestStack;

  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  it('groups an inbound webhook event by the workspace cloud ids', async () => {
    const ws = await createWorkspace(stack.app, 'telemetry-webhook-groups');
    await stack.runtime.deps.db
      .update(workspaces)
      .set({ metadata: { cloud_org_id: 'org_1', cloud_workspace_id: 'cws_1' } })
      .where(eq(workspaces.id, ws.workspaceId));

    const createResponse = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ channel: 'general', name: 'provider-events' }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json() as { data: { webhook_id: string; token: string } }).data;

    const capture = vi.spyOn(stack.runtime.deps.telemetry, 'capture');
    const response = await stack.app.request(`/v1/hooks/${created.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ text: 'pull request opened', source: 'github' }),
    });
    expect(response.status).toBe(201);
    await stack.settle();

    const triggered = capture.mock.calls
      .map(([event]) => event as TelemetryEvent)
      .find((event) => event.name === 'relaycast_server_inbound_webhook_triggered');
    expect(triggered).toMatchObject({
      distinctId: `relaycast-ws:${ws.workspaceId}`,
      processPersonProfile: false,
      groups: { organization: 'org_1', workspace: 'cws_1' },
    });
  });
});
