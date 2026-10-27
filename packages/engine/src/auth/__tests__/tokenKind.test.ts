import { describe, expect, it } from 'vitest';
import {
  getAuthTokenKind,
  parseAuthToken,
  validateTokenRequirement,
} from '../tokenKind.js';

describe('auth token kind parsing', () => {
  it('parses supported live token prefixes with zod schemas', () => {
    expect(parseAuthToken('rk_live_workspace')).toEqual({ kind: 'workspace', token: 'rk_live_workspace' });
    expect(parseAuthToken('at_live_agent')).toEqual({ kind: 'agent', token: 'at_live_agent' });
    expect(parseAuthToken('nt_live_node')).toEqual({ kind: 'node', token: 'nt_live_node' });
    expect(parseAuthToken('ot_live_observer')).toEqual({ kind: 'observer', token: 'ot_live_observer' });
  });

  it('rejects unsupported token formats', () => {
    expect(getAuthTokenKind('not_a_token')).toBeUndefined();
    expect(getAuthTokenKind('rk_test_workspace')).toBeUndefined();
  });
});

describe('auth token requirement validation', () => {
  it('allows workspace and agent tokens for generic auth', () => {
    expect(validateTokenRequirement('workspace', 'any')).toEqual({ ok: true });
    expect(validateTokenRequirement('agent', 'any')).toEqual({ ok: true });
  });

  it('returns required-token messages for user credential mismatches', () => {
    expect(validateTokenRequirement('workspace', 'agent')).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'Agent token required (at_live_...)',
    });
    expect(validateTokenRequirement('agent', 'workspace')).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'Workspace key required (rk_live_...)',
    });
    expect(validateTokenRequirement('workspace', 'node')).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'Node token required (nt_live_...)',
    });
    expect(validateTokenRequirement('agent', 'observer')).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'Observer token required (ot_live_...)',
    });
  });

  it('keeps transport-only tokens forbidden outside their own auth paths', () => {
    expect(validateTokenRequirement('node', 'any')).toEqual({
      ok: false,
      code: 'node_token_forbidden',
      message: 'Node token cannot perform this operation',
    });
    expect(validateTokenRequirement('observer', 'node')).toEqual({
      ok: false,
      code: 'observer_token_forbidden',
      message: 'Observer token cannot perform this operation',
    });
  });
});
