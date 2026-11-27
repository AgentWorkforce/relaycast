import { describe, expect, it } from 'vitest';
import { errorText } from '../log.js';

describe('errorText', () => {
  it('masks every ar_ credential kind, agent device tokens included', () => {
    for (const code of ['ws', 'ag', 'ad', 'nd', 'ob', 'wh']) {
      expect(errorText(new Error(`bad ar_${code}_0000000000a_aX7pQ2mN4bc_secret`))).toBe('bad ar_***');
    }
    expect(errorText('Bearer at_live_dv_abc')).toBe('Bearer ***');
  });
});
