import { describe, expect, it } from 'vitest';

import { isSupportedSlackMessageSubtype } from '../shared/message-subtypes.js';

describe('slack-relay message subtype filtering', () => {
  it('keeps ordinary and bot-authored messages materializable', () => {
    expect(isSupportedSlackMessageSubtype(undefined)).toBe(true);
    expect(isSupportedSlackMessageSubtype('bot_message')).toBe(true);
  });

  it('still filters Slack system message subtypes', () => {
    expect(isSupportedSlackMessageSubtype('channel_join')).toBe(false);
    expect(isSupportedSlackMessageSubtype('message_deleted')).toBe(false);
  });
});
