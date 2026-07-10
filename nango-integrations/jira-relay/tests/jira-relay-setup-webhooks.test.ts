import { describe, expect, it, vi } from 'vitest';

import setupWebhooks from '../on-events/setup-webhooks.js';

function createNango(overrides: Record<string, unknown> = {}) {
  class ActionError extends Error {
    type?: string;

    constructor({ message, type }: { message: string; type?: string }) {
      super(message);
      this.name = 'ActionError';
      this.type = type;
    }
  }

  return {
    ActionError,
    connectionId: 'conn-jira-123',
    getIntegration: vi.fn().mockResolvedValue({ webhook_url: 'https://api.nango.dev/webhook/test/jira-relay' }),
    getWebhookURL: vi.fn(),
    log: vi.fn(),
    triggerAction: vi.fn().mockResolvedValue({ webhooks: [] }),
    ...overrides,
  };
}

describe('jira-relay setup-webhooks on-event', () => {
  it('registers dynamic webhooks for synced Jira objects', async () => {
    const nango = createNango();

    await setupWebhooks.exec(nango as any);

    expect(nango.triggerAction).toHaveBeenNthCalledWith(1, 'jira-relay', 'conn-jira-123', 'list-webhooks', {});
    expect(nango.triggerAction).toHaveBeenNthCalledWith(2, 'jira-relay', 'conn-jira-123', 'register-webhook', {
      url: 'https://api.nango.dev/webhook/test/jira-relay',
      events: [
        'jira:issue_created',
        'jira:issue_updated',
        'jira:issue_deleted',
        'project_created',
        'project_updated',
        'project_deleted',
        'sprint_created',
        'sprint_updated',
        'sprint_started',
        'sprint_closed',
        'sprint_deleted',
      ],
      jqlFilter: '',
    });
  });

  it('adds missing dynamic webhook events and refreshes the existing registration', async () => {
    const nango = createNango({
      triggerAction: vi.fn().mockResolvedValueOnce({
        webhooks: [
          {
            id: '72',
            url: 'https://api.nango.dev/webhook/test/jira-relay',
            events: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'],
          },
        ],
      }),
    });

    await setupWebhooks.exec(nango as any);

    expect(nango.triggerAction).toHaveBeenNthCalledWith(2, 'jira-relay', 'conn-jira-123', 'register-webhook', {
      url: 'https://api.nango.dev/webhook/test/jira-relay',
      events: [
        'project_created',
        'project_updated',
        'project_deleted',
        'sprint_created',
        'sprint_updated',
        'sprint_started',
        'sprint_closed',
        'sprint_deleted',
      ],
      jqlFilter: '',
    });
    expect(nango.triggerAction).toHaveBeenNthCalledWith(3, 'jira-relay', 'conn-jira-123', 'update-webhook', {
      webhookId: '72',
    });
  });
});
