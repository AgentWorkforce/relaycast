import { describe, expect, it } from 'vitest';
import { stableRelaycastEventId } from '../event-id.js';

describe('stableRelaycastEventId', () => {
  it('preserves part boundaries when hashing', () => {
    expect(stableRelaycastEventId('a', 'b:c')).not.toBe(stableRelaycastEventId('a:b', 'c'));
  });

  it('uses the stable empty-event fallback for blank input', () => {
    expect(stableRelaycastEventId()).toBe(stableRelaycastEventId('empty-event'));
    expect(stableRelaycastEventId('  ', undefined, null)).toBe(stableRelaycastEventId('empty-event'));
  });
});
