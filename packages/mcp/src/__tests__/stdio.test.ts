import { describe, it, expect } from 'vitest';
import {
  parseWorkspaceEnv,
  validateWorkspaceConfigs,
  resolveDefaultWorkspaceId,
} from '../workspaces.js';
import type { McpWorkspaceConfig } from '../workspaces.js';

describe('RELAY_WORKSPACES_JSON parsing', () => {
  it('returns empty array for undefined input', () => {
    expect(parseWorkspaceEnv(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseWorkspaceEnv('')).toEqual([]);
    expect(parseWorkspaceEnv('  ')).toEqual([]);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseWorkspaceEnv('not-json')).toThrow('not valid JSON');
  });

  it('throws when value is not an array', () => {
    expect(() => parseWorkspaceEnv('{"foo":"bar"}')).toThrow('must be a JSON array');
  });

  it('parses valid workspace configs', () => {
    const json = JSON.stringify([
      {
        workspace_id: 'ws_alpha',
        workspace_alias: 'alpha',
        api_key: 'rk_live_alpha',
        agent_token: 'at_live_alpha',
        agent_name: 'Alpha',
      },
      {
        workspace_id: 'ws_beta',
        api_key: 'rk_live_beta',
      },
    ]);

    const configs = parseWorkspaceEnv(json);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({
      workspace_id: 'ws_alpha',
      workspace_alias: 'alpha',
      api_key: 'rk_live_alpha',
      agent_token: 'at_live_alpha',
      agent_name: 'Alpha',
    });
    expect(configs[1]).toEqual({
      workspace_id: 'ws_beta',
      workspace_alias: undefined,
      api_key: 'rk_live_beta',
      agent_token: undefined,
      agent_name: undefined,
    });
  });

  it('throws when workspace_id is missing', () => {
    const json = JSON.stringify([{ api_key: 'rk_live_x' }]);
    expect(() => parseWorkspaceEnv(json)).toThrow('workspace_id is required');
  });

  it('throws when api_key is missing', () => {
    const json = JSON.stringify([{ workspace_id: 'ws_1' }]);
    expect(() => parseWorkspaceEnv(json)).toThrow('api_key is required');
  });
});

describe('validateWorkspaceConfigs', () => {
  it('rejects non-object entries', () => {
    expect(() => validateWorkspaceConfigs(['string'])).toThrow('must be an object');
  });

  it('accepts valid entries', () => {
    const result = validateWorkspaceConfigs([
      { workspace_id: 'ws_1', api_key: 'rk_live_1' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].workspace_id).toBe('ws_1');
  });
});

describe('resolveDefaultWorkspaceId', () => {
  const configs: McpWorkspaceConfig[] = [
    { workspace_id: 'ws_alpha', workspace_alias: 'alpha', api_key: 'rk_live_alpha' },
    { workspace_id: 'ws_beta', api_key: 'rk_live_beta' },
  ];

  it('returns undefined for empty configs', () => {
    expect(resolveDefaultWorkspaceId([])).toBeUndefined();
  });

  it('returns first workspace_id when no default specified', () => {
    expect(resolveDefaultWorkspaceId(configs)).toBe('ws_alpha');
  });

  it('resolves default by workspace_id', () => {
    expect(resolveDefaultWorkspaceId(configs, 'ws_beta')).toBe('ws_beta');
  });

  it('resolves default by workspace_alias', () => {
    expect(resolveDefaultWorkspaceId(configs, 'alpha')).toBe('ws_alpha');
  });

  it('falls back to first when default does not match', () => {
    expect(resolveDefaultWorkspaceId(configs, 'nonexistent')).toBe('ws_alpha');
  });
});
