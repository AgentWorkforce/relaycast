import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceToolRegistry } from './workspace-tool-registry.js';
import type { RelayFileWorkspaceReader } from './relayfile-workspace-reader.js';

// The registry's reader contract is structural — we only mock the methods
// the registry actually calls (readFile, listTree, searchFiles, statFile,
// enumerate, isEnabled). Cast through unknown so we don't have to stub the
// concrete class's private fields like `client`, `cacheTtlMs`, etc.
function createReader(overrides: Partial<RelayFileWorkspaceReader> = {}): RelayFileWorkspaceReader {
  return {
    isEnabled: () => true,
    listTree: vi.fn(async () => []),
    readFile: vi.fn(async () => null),
    searchFiles: vi.fn(async () => []),
    statFile: vi.fn(async () => null),
    enumerate: vi.fn(async () => []),
    ...overrides,
  } as unknown as RelayFileWorkspaceReader;
}

const READ_CALL = {
  id: 'call-1',
  name: 'workspace_read',
  input: { path: '/github/repos/AgentWorkforce/cloud/pulls/105/metadata.json' },
};

describe('createWorkspaceToolRegistry workspace_read', () => {
  // Regression for the production trace where the specialist's inner harness
  // hit `tool_error_unrecoverable` the moment the model speculatively read a
  // PR metadata path that was not in the VFS. The harness aborts on any
  // tool result with `status: 'error'` + `retryable !== true` (see
  // `harness.ts:331`), so the previous `notFoundResult({status:'error',
  // code:'not_found', retryable:false})` shape force-killed the entire turn.
  // Returning the absence as a successful textual result lets the model
  // treat it as a soft signal and continue.
  it('returns success with a "file not found" body when the path does not exist (does NOT trigger tool_error_unrecoverable)', async () => {
    const reader = createReader({ readFile: vi.fn(async () => null) });
    const registry = createWorkspaceToolRegistry({ reader });

    const result = await registry.execute(READ_CALL, {
      assistantId: 'sage-github-specialist',
      turnId: 't1',
      iteration: 1,
      toolCallIndex: 0,
    });

    expect(result.status).toBe('success');
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('Workspace file not found');
    expect(result.output).toContain(READ_CALL.input.path);
  });

  it('still returns successful read output when the file exists', async () => {
    const reader = createReader({ readFile: vi.fn(async () => 'file body content') });
    const registry = createWorkspaceToolRegistry({ reader });

    const result = await registry.execute(READ_CALL, {
      assistantId: 'sage-github-specialist',
      turnId: 't1',
      iteration: 1,
      toolCallIndex: 0,
    });

    expect(result.status).toBe('success');
    expect(result.output).toContain('file body content');
  });

  it('still returns a real error (status="error") when the reader throws an unexpected exception', async () => {
    const reader = createReader({
      readFile: vi.fn(async () => {
        throw new Error('upstream timeout');
      }),
    });
    const registry = createWorkspaceToolRegistry({ reader });

    const result = await registry.execute(READ_CALL, {
      assistantId: 'sage-github-specialist',
      turnId: 't1',
      iteration: 1,
      toolCallIndex: 0,
    });

    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('tool_error');
    // thrownErrorResult marks retryable=true so the harness can recover
    // (vs not_found which is now a soft success — different mechanism, same
    // goal of not killing turns over recoverable conditions).
    expect(result.error?.retryable).toBe(true);
  });
});
