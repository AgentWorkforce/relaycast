import { describe, expect, it } from 'vitest';

import sync from '../syncs/fetch-channel-history.js';

describe('slack-relay webhook subscriptions', () => {
  it('uses Slack event payload type names for Nango webhook dispatch', () => {
    expect(sync.webhookSubscriptions).toEqual(['app_mention', 'message']);
  });
});
