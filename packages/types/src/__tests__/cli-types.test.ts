import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliTypeSchema, SpawnAgentRequestSchema } from '../index.js';

const supportedClis = ['claude', 'codex', 'gemini', 'aider', 'goose', 'opencode', 'grok', 'muse', 'devin'];

describe('spawn CLI types', () => {
  it.each(supportedClis)('accepts %s without changing the request', (cli) => {
    const request = { name: 'worker', cli, task: 'Review the code' };
    expect(CliTypeSchema.parse(cli)).toBe(cli);
    expect(SpawnAgentRequestSchema.parse(request)).toEqual(request);
  });

  it.each(['unknown', '', 'Muse', 'DEVIN', 'OpenCode', 'GROK'])('rejects unsupported CLI %j', (cli) => {
    expect(CliTypeSchema.safeParse(cli).success).toBe(false);
    expect(SpawnAgentRequestSchema.safeParse({ name: 'worker', cli, task: 'Review' }).success).toBe(false);
  });

  it('keeps the OpenAPI spawn enum aligned with the shared schema', () => {
    const openapi = readFileSync(new URL('../../../../openapi.yaml', import.meta.url), 'utf8');
    const spawn = openapi.split('  /agents/spawn:')[1]?.split(/\n  \/[^ ]/)[0];
    const values = spawn?.match(/enum: \[([^\]]+)\]/)?.[1].split(',').map((value) => value.trim());
    expect(values).toEqual(CliTypeSchema.options);
    expect(CliTypeSchema.options).toEqual(supportedClis);
  });
});
