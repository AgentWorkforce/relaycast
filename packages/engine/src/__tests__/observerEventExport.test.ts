import { describe, expect, it } from 'vitest';
import { observerAllowsEvent, type ObserverToken } from '../index.js';

// The Cloudflare workspace stream fans events out outside this package and
// imports this filter from the public entry; pin both the export and the
// behaviour it relies on for a channel-scoped token.
const scoped = {
  scopes: ['stream:read', 'messages:read', 'dms:read', 'channels:read'],
  filters: { channel_names: ['wf-run'], include_dms: false },
} as Pick<ObserverToken, 'scopes' | 'filters'>;

describe('observerAllowsEvent (public export)', () => {
  it('passes the scoped channel and withholds DMs and other channels', () => {
    expect(observerAllowsEvent(scoped, { type: 'message.created', channel: 'wf-run', message: { agent_id: 'a' } })).toBe(true);
    expect(observerAllowsEvent(scoped, { type: 'message.created', channel: 'general', message: { agent_id: 'a' } })).toBe(false);
    expect(observerAllowsEvent(scoped, { type: 'dm.received', conversation_id: 'dm_1' })).toBe(false);
    expect(observerAllowsEvent(scoped, { type: 'group_dm.received' })).toBe(false);
  });

  it('lets an unscoped principal (workspace key) see everything', () => {
    expect(observerAllowsEvent(undefined, { type: 'dm.received', conversation_id: 'dm_1' })).toBe(true);
  });
});
