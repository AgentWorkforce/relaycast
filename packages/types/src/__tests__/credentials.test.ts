import { describe, expect, it } from 'vitest';
import {
  credentialKind,
  credentialTextPattern,
  credentialWorkspaceId,
  isObserverToken,
  isWorkspaceKey,
} from '../credentials.js';

const HEX = 'a'.repeat(64);

describe('credential families', () => {
  it('classifies both families by kind', () => {
    expect(credentialKind('rk_live_abc')).toBe('workspace');
    expect(credentialKind('at_live_abc')).toBe('agent');
    expect(credentialKind('nt_live_abc')).toBe('node');
    expect(credentialKind('ot_live_abc')).toBe('observer');
    expect(credentialKind('wh_live_abc')).toBe('webhook');
    expect(credentialKind(`relaycast_ws_123_${HEX}`)).toBe('workspace');
    expect(credentialKind(`relaycast_ag_123_${HEX}`)).toBe('agent');
    expect(credentialKind(`relaycast_nd_123_${HEX}`)).toBe('node');
    expect(credentialKind(`relaycast_ob_123_${HEX}`)).toBe('observer');
    expect(credentialKind(`relaycast_wh_123_${HEX}`)).toBe('webhook');
  });

  it('rejects other shapes', () => {
    expect(credentialKind('rk_test_abc')).toBeUndefined();
    expect(credentialKind(`relaycast_xx_123_${HEX}`)).toBeUndefined();
    expect(credentialKind(`relaycast_ws_123_${'a'.repeat(63)}`)).toBeUndefined();
    expect(credentialKind('')).toBeUndefined();
  });

  it('reads the workspace a self-routing credential names', () => {
    expect(credentialWorkspaceId(`relaycast_ag_241764880589606912_${HEX}`)).toBe('241764880589606912');
    expect(credentialWorkspaceId('at_live_abc')).toBeUndefined();
  });

  it('answers the common checks', () => {
    expect(isWorkspaceKey('rk_live_abc')).toBe(true);
    expect(isWorkspaceKey(`relaycast_ws_1_${HEX}`)).toBe(true);
    expect(isWorkspaceKey(`relaycast_ob_1_${HEX}`)).toBe(false);
    expect(isObserverToken('ot_live_abc')).toBe(true);
    expect(isObserverToken(`relaycast_ob_1_${HEX}`)).toBe(true);
    expect(isObserverToken('rk_live_abc')).toBe(false);
  });

  it('finds either family in text', () => {
    const text = `key rk_live_abc and relaycast_ag_9_${HEX}.`;
    expect(text.replace(credentialTextPattern(), '[x]')).toBe('key [x] and [x].');
  });
});
