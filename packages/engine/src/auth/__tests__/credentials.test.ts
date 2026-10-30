import { describe, expect, it } from 'vitest';
import {
  configureCredentialFormat,
  credentialFormat,
  credentialFromHex,
  credentialShape,
  issueCredential,
  mintCredential,
  parseCredential,
  parseSelfRoutingCredential,
} from '../credentials.js';
import { getAuthTokenKind, requiredTokenMessage } from '../tokenKind.js';

const WS = '241764880589606912';

describe('credential families', () => {
  it('mints live credentials with the established prefixes and lengths', () => {
    expect(mintCredential('live', 'workspace', WS)).toMatch(/^rk_live_[0-9a-f]{32}$/);
    expect(mintCredential('live', 'agent', WS)).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect(mintCredential('live', 'node', WS)).toMatch(/^nt_live_[0-9a-f]{48}$/);
    expect(mintCredential('live', 'observer', WS)).toMatch(/^ot_live_[0-9a-f]{48}$/);
    expect(mintCredential('live', 'webhook', WS)).toMatch(/^wh_live_[0-9a-f]{48}$/);
  });

  it('mints self-routing credentials that name their kind and workspace', () => {
    const cases = [['workspace', 'ws'], ['agent', 'ag'], ['node', 'nd'], ['observer', 'ob'], ['webhook', 'wh']] as const;
    for (const [kind, code] of cases) {
      const token = mintCredential('self_routing', kind, WS);
      expect(token).toMatch(new RegExp(`^relaycast_${code}_${WS}_[0-9a-f]{64}$`));
      expect(parseSelfRoutingCredential(token)).toEqual({ kind, workspaceId: WS });
      expect(parseCredential(token)).toEqual({ family: 'self_routing', kind, workspaceId: WS });
    }
  });

  it('classifies both families', () => {
    const live = mintCredential('live', 'agent', WS);
    const routed = mintCredential('self_routing', 'agent', WS);
    expect(parseCredential(live)).toEqual({ family: 'live', kind: 'agent' });
    expect(getAuthTokenKind(live)).toBe('agent');
    expect(getAuthTokenKind(routed)).toBe('agent');
    expect(getAuthTokenKind('not_a_token')).toBeUndefined();
    // Webhook tokens never authenticate API calls.
    expect(getAuthTokenKind(mintCredential('self_routing', 'webhook', WS))).toBeUndefined();
    expect(getAuthTokenKind(mintCredential('live', 'webhook', WS))).toBeUndefined();
  });

  it('rejects malformed self-routing credentials', () => {
    expect(parseSelfRoutingCredential(`relaycast_xx_${WS}_${'a'.repeat(64)}`)).toBeUndefined();
    expect(parseSelfRoutingCredential(`relaycast_ws_${WS}_${'a'.repeat(63)}`)).toBeUndefined();
    expect(parseSelfRoutingCredential(`relaycast_ws_${WS}_${'A'.repeat(64)}`)).toBeUndefined();
    expect(parseSelfRoutingCredential(`relaycast_ws__${'a'.repeat(64)}`)).toBeUndefined();
    expect(() => mintCredential('self_routing', 'agent', 'ws_1')).toThrow(/cannot be embedded/);
  });

  it('derives credentials from digests at each family length', () => {
    const digest = 'ab'.repeat(32);
    expect(credentialFromHex('live', 'node', WS, digest)).toBe(`nt_live_${digest.slice(0, 48)}`);
    expect(credentialFromHex('self_routing', 'node', WS, digest)).toBe(`relaycast_nd_${WS}_${digest}`);
  });

  it('names the family in required-credential messages', () => {
    expect(requiredTokenMessage('agent', 'live')).toBe('Agent token required (at_live_...)');
    expect(requiredTokenMessage('agent', 'self_routing')).toBe('Agent token required (relaycast_ag_...)');
    expect(credentialShape('workspace', 'self_routing')).toBe('relaycast_ws_...');
  });

  it('binds the family to a database handle, defaulting to live', () => {
    const db = {};
    expect(credentialFormat(db)).toBe('live');
    configureCredentialFormat(db, 'self_routing');
    expect(issueCredential(db, 'workspace', WS)).toMatch(/^relaycast_ws_/);
    configureCredentialFormat(db, 'live');
    expect(issueCredential(db, 'workspace', WS)).toMatch(/^rk_live_/);
  });
});
