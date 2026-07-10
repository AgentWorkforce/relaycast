import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceToolRegistry } from '../src/specialist/workspace-tool-registry.js';
import type { RelayFileWorkspaceReader } from '../src/specialist/relayfile-workspace-reader.js';

function createReader(content: string): RelayFileWorkspaceReader {
  return {
    isEnabled: () => true,
    readFile: vi.fn(async () => content),
    searchFiles: vi.fn(async () => []),
    listTree: vi.fn(async () => []),
  } as unknown as RelayFileWorkspaceReader;
}

function createReadCall(input: Record<string, unknown>) {
  return {
    id: 'call-1',
    name: 'workspace_read',
    input,
  };
}

describe('createWorkspaceToolRegistry workspace_read', () => {
  it('returns small files unchanged', async () => {
    const registry = createWorkspaceToolRegistry({ reader: createReader('hello world') });

    const result = await registry.execute(
      createReadCall({ path: '/github/repos/acme/app/README.md' }),
      { turnId: 'turn-1', iteration: 1, toolCallIndex: 0 },
    );

    expect(result.status).toBe('success');
    expect(result.output).toBe('hello world');
  });

  it('truncates large reads and reports the next offset', async () => {
    const registry = createWorkspaceToolRegistry({ reader: createReader('a'.repeat(60 * 1024)) });

    const result = await registry.execute(
      createReadCall({ path: '/github/repos/acme/app/pulls/12/diff.patch' }),
      { turnId: 'turn-1', iteration: 1, toolCallIndex: 0 },
    );

    expect(result.status).toBe('success');
    expect(result.output).toContain('[workspace_read_truncated]');
    expect(result.output).toContain('bytes_returned=51200');
    expect(result.output).toContain('total_bytes=61440');
    expect(result.output).toContain('next_offset=51200');
  });

  it('supports reading a bounded window from an offset', async () => {
    const registry = createWorkspaceToolRegistry({ reader: createReader('0123456789abcdef') });

    const result = await registry.execute(
      createReadCall({
        path: '/github/repos/acme/app/file.txt',
        offset: 10,
        maxBytes: 3,
      }),
      { turnId: 'turn-1', iteration: 1, toolCallIndex: 0 },
    );

    expect(result.status).toBe('success');
    expect(result.output).toContain('abc');
    expect(result.output).toContain('offset=10');
    expect(result.output).toContain('next_offset=13');
  });

  it('does not split multibyte UTF-8 characters across read pages', async () => {
    const registry = createWorkspaceToolRegistry({ reader: createReader('café') });

    const first = await registry.execute(
      createReadCall({
        path: '/github/repos/acme/app/unicode.txt',
        maxBytes: 4,
      }),
      { turnId: 'turn-1', iteration: 1, toolCallIndex: 0 },
    );
    const second = await registry.execute(
      createReadCall({
        path: '/github/repos/acme/app/unicode.txt',
        offset: 3,
        maxBytes: 4,
      }),
      { turnId: 'turn-1', iteration: 1, toolCallIndex: 0 },
    );

    expect(first.status).toBe('success');
    expect(first.output).toContain('caf');
    expect(first.output).toContain('next_offset=3');
    expect(first.output).not.toContain('\uFFFD');
    expect(second.status).toBe('success');
    expect(second.output).toContain('é');
    expect(second.output).not.toContain('\uFFFD');
  });

  it('makes progress when maxBytes is smaller than one multibyte character', async () => {
    const registry = createWorkspaceToolRegistry({ reader: createReader('🙂x') });

    const result = await registry.execute(
      createReadCall({
        path: '/github/repos/acme/app/emoji.txt',
        maxBytes: 1,
      }),
      { turnId: 'turn-1', iteration: 1, toolCallIndex: 0 },
    );

    expect(result.status).toBe('success');
    expect(result.output).toContain('🙂');
    expect(result.output).toContain('bytes_returned=4');
    expect(result.output).toContain('next_offset=4');
    expect(result.output).not.toContain('\uFFFD');
  });
});
