import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliTypeSchema, HARNESS_ID_PATTERN, SpawnAgentRequestSchema } from '../index.js';

const namedClis = ['claude', 'codex', 'gemini', 'aider', 'goose', 'opencode', 'grok', 'muse', 'devin'];

describe('spawn CLI types', () => {
  it.each([...namedClis, 'cursor', 'unknown'])('accepts %s without changing the request', (cli) => {
    const request = { name: 'worker', cli, task: 'Review the code' };
    expect(CliTypeSchema.parse(cli)).toBe(cli);
    expect(SpawnAgentRequestSchema.parse(request)).toEqual(request);
  });

  it.each(['', 'Muse', 'DEVIN', 'OpenCode', 'GROK', 'cursor_ai', 'cursor\n'])('rejects malformed CLI %j', (cli) => {
    expect(CliTypeSchema.safeParse(cli).success).toBe(false);
    expect(SpawnAgentRequestSchema.safeParse({ name: 'worker', cli, task: 'Review' }).success).toBe(false);
  });

  it('keeps the OpenAPI spawn pattern aligned with the shared schema', () => {
    const openapi = readFileSync(new URL('../../../../openapi.yaml', import.meta.url), 'utf8');
    const spawn = openapi.split('  /agents/spawn:')[1]?.split(/\n  \/[^ ]/)[0] ?? '';
    const pattern = spawn.match(/pattern: '([^']+)'/)?.[1];
    expect(pattern).toBe(HARNESS_ID_PATTERN.source);
    expect(spawn).not.toMatch(/enum:/);
    for (const cli of namedClis) {
      expect(spawn).toContain(cli);
    }
  });
});
