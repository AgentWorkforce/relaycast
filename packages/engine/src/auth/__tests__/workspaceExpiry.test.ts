import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_EXPIRED_CODE,
  authenticateUnexpired,
  isWorkspaceExpired,
} from '../workspaceExpiry.js';
import type { AuthProvider, AuthResult, Workspace } from '../../ports/auth.js';
import type { EngineDb } from '../../ports/database.js';

const now = new Date('2026-10-01T08:20:00.000Z');

function workspace(expiresAt: Date | null): Workspace {
  return { id: 'ws_1', expiresAt } as Workspace;
}

function providerReturning(result: AuthResult): AuthProvider {
  return {
    authenticate: async () => result,
    hashToken: async (token: string) => token,
  };
}

const args = { token: 'rk_live_x', require: 'workspace' as const, db: {} as EngineDb };

describe('isWorkspaceExpired', () => {
  it('is false without a deadline', () => {
    expect(isWorkspaceExpired(workspace(null), now)).toBe(false);
  });

  it('is false before the deadline and true at or after it', () => {
    expect(isWorkspaceExpired(workspace(new Date(now.getTime() + 1)), now)).toBe(false);
    expect(isWorkspaceExpired(workspace(now), now)).toBe(true);
    expect(isWorkspaceExpired(workspace(new Date(now.getTime() - 1)), now)).toBe(true);
  });
});

describe('authenticateUnexpired', () => {
  it('rejects an expired workspace an injected provider admitted', async () => {
    const provider = providerReturning({ ok: true, workspace: workspace(new Date(Date.now() - 1_000)) });
    expect(await authenticateUnexpired(provider, args)).toMatchObject({
      ok: false, status: 401, code: WORKSPACE_EXPIRED_CODE,
    });
  });

  it('passes a live workspace and the provider principal through untouched', async () => {
    const admitted: AuthResult = { ok: true, workspace: workspace(new Date(Date.now() + 60_000)) };
    expect(await authenticateUnexpired(providerReturning(admitted), args)).toBe(admitted);
  });

  it('preserves the provider rejection rather than relabelling it', async () => {
    const denied: AuthResult = { ok: false, status: 401, code: 'agent_token_invalid', message: 'nope' };
    expect(await authenticateUnexpired(providerReturning(denied), args)).toBe(denied);
  });
});
