import { describe, expect, it } from 'vitest';
import {
  credentialKind,
  credentialWorkspaceId,
  isObserverToken,
  isWorkspaceKey,
  maskCredential,
  parseCredential,
  redactCredentials,
} from '../credentials.js';

const HEX = '0123456789abcdef'.repeat(4);
const WS = '241764880589606912';

describe('credential families', () => {
  it('classifies both families by family and kind', () => {
    expect(parseCredential('rk_live_abc')).toEqual({ family: 'live', kind: 'workspace' });
    expect(credentialKind('at_live_abc')).toBe('agent');
    expect(credentialKind('nt_live_abc')).toBe('node');
    expect(credentialKind('ot_live_abc')).toBe('observer');
    expect(credentialKind('wh_live_abc')).toBe('webhook');
    expect(parseCredential(`relaycast_ob_${WS}_${HEX}`)).toEqual({ family: 'self_routing', kind: 'observer', workspaceId: WS });
    expect(credentialKind(`relaycast_ws_${WS}_${HEX}`)).toBe('workspace');
    expect(credentialKind(`relaycast_ag_${WS}_${HEX}`)).toBe('agent');
    expect(credentialKind(`relaycast_nd_${WS}_${HEX}`)).toBe('node');
    expect(credentialKind(`relaycast_wh_${WS}_${HEX}`)).toBe('webhook');
  });

  it('rejects other shapes', () => {
    expect(credentialKind('rk_test_abc')).toBeUndefined();
    expect(credentialKind(`relaycast_xx_${WS}_${HEX}`)).toBeUndefined();
    expect(credentialKind(`relaycast_ws_${WS}_${HEX.slice(1)}`)).toBeUndefined();
    expect(credentialKind(`relaycast_ws_${WS}_${HEX}x`)).toBeUndefined();
    expect(credentialKind('')).toBeUndefined();
  });

  it('answers the common checks', () => {
    expect(credentialWorkspaceId(`relaycast_ag_${WS}_${HEX}`)).toBe(WS);
    expect(credentialWorkspaceId('at_live_abc')).toBeUndefined();
    expect(isWorkspaceKey('rk_live_abc')).toBe(true);
    expect(isWorkspaceKey(`relaycast_ws_${WS}_${HEX}`)).toBe(true);
    expect(isWorkspaceKey(`relaycast_ob_${WS}_${HEX}`)).toBe(false);
    expect(isObserverToken(`relaycast_ob_${WS}_${HEX}`)).toBe(true);
  });

  it('masks by structure', () => {
    expect(maskCredential('rk_live_mask_fixture_key_wxyz')).toBe('rk_live_mask...wxyz');
    expect(maskCredential(`relaycast_ws_${WS}_${HEX}`)).toBe(`relaycast_ws_${WS}_0123...cdef`);
  });

  it('redacts credentials glued to surrounding text', () => {
    const routed = `relaycast_ag_${WS}_${HEX}`;
    expect(redactCredentials(`key:${routed}xyz and ${routed}.`, '[x]')).toBe('key:[x]xyz and [x].');
    expect(redactCredentials(`(rk_live_abc)and prefixot_live_def`, '[x]')).toBe('([x])and prefix[x]');
    expect(redactCredentials(`x${routed}0`, '[x]')).toBe('x[x]0');
  });
});
