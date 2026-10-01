import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspace, makeNodeStack, type TestStack } from './harness.js';

describe('workspace update telemetry', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => { vi.restoreAllMocks(); stack.close(); });

  it.each([
    { label: 'omitted metadata', body: { name: 'renamed' }, changedMetadata: false },
    { label: 'metadata labels', body: { metadata: { project: 'descriptive-value-not-in-event' } }, changedMetadata: true },
    { label: 'empty metadata patch', body: { metadata: {} }, changedMetadata: true },
    { label: 'metadata deletion', body: { metadata: { project: null } }, changedMetadata: true },
  ])('records supplied metadata for $label without values', async ({ body, changedMetadata }) => {
    const ws = await createWorkspace(stack.app, 'workspace-telemetry');
    const capture = vi.spyOn(stack.runtime.deps.telemetry, 'capture');
    const response = await stack.app.request('/v1/workspace', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${ws.workspaceKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const events = capture.mock.calls.map(([event]) => event)
      .filter((event) => event.name === 'relaycast_server_workspace_updated');
    expect(events).toHaveLength(1);
    expect(events[0].properties).toMatchObject({
      workspace_id: ws.workspaceId,
      changed_name: 'name' in body,
      changed_system_prompt: false,
      changed_metadata: changedMetadata,
    });
    expect(events[0].properties).not.toHaveProperty('metadata');
    expect(events[0].properties).not.toHaveProperty('project');
    expect(JSON.stringify(events[0])).not.toContain('descriptive-value-not-in-event');
  });
});
