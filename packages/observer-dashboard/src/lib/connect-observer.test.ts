import { describe, expect, it } from 'vitest';
import { formatUtcTimestamp, sanitizeConnectObserverText } from './connect-observer';

describe('Relay Connect observer presentation', () => {
  it('renders message timestamps explicitly in UTC', () => {
    expect(formatUtcTimestamp('2026-10-05T05:46:12.000Z')).toBe('2026-10-05 05:46:12 UTC');
    expect(formatUtcTimestamp('2026-10-05T05:46:12.345Z')).toBe('2026-10-05 05:46:12.345 UTC');
  });

  it('redacts capability material and Connect invite URLs from observed text', () => {
    expect(
      sanitizeConnectObserverText(
        'Use https://agentrelay.com/connect/opaque_room.md?x=1 with ot_live_secret and rk_live_admin.',
      ),
    ).toBe('Use [Relay Connect invite redacted] with [credential redacted] and [credential redacted].');
  });
});
