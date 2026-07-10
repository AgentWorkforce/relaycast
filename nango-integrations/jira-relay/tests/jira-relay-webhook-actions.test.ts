import { describe, expect, it, vi } from 'vitest';

import deleteWebhook from '../actions/delete-webhook.js';
import getWebhook from '../actions/get-webhook.js';
import listWebhooks from '../actions/list-webhooks.js';
import registerWebhook from '../actions/register-webhook.js';
import updateWebhook from '../actions/update-webhook.js';

const siteMetadata = { cloudId: 'cloud-123', baseUrl: 'https://relayfile.atlassian.net' };
const webhookResponse = {
  id: 72,
  url: 'https://relayfile.example.com/api/v1/webhooks/jira',
  events: ['jira:issue_created', 'jira:issue_updated'],
  expirationDate: '2026-06-01T12:42:30.000+0000',
  fieldIdsFilter: ['summary'],
  jqlFilter: 'project = RLY',
};

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
    getMetadata: vi.fn().mockResolvedValue(siteMetadata),
    getConnection: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

describe('jira-relay webhook actions', () => {
  it('lists dynamic webhooks through the Atlassian OAuth gateway', async () => {
    const nango = createNango({
      get: vi.fn().mockResolvedValue({ data: { values: [webhookResponse] } }),
    });

    const result = await listWebhooks.exec(nango as any, undefined);

    expect(nango.get).toHaveBeenCalledWith({
      endpoint: '/ex/jira/cloud-123/rest/api/3/webhook',
      retries: 3,
    });
    expect(result.webhooks).toEqual([
      {
        id: '72',
        url: webhookResponse.url,
        events: webhookResponse.events,
        expirationDate: webhookResponse.expirationDate,
        fieldIdsFilter: webhookResponse.fieldIdsFilter,
        jqlFilter: webhookResponse.jqlFilter,
      },
    ]);
  });

  it('registers and refreshes dynamic webhooks', async () => {
    const registerNango = createNango({
      post: vi.fn().mockResolvedValue({ data: { webhookRegistrationResult: [{ createdWebhookId: 72 }] } }),
    });
    const input = {
      url: webhookResponse.url,
      events: webhookResponse.events,
      jqlFilter: webhookResponse.jqlFilter,
      fieldIdsFilter: webhookResponse.fieldIdsFilter,
    };

    const created = await registerWebhook.exec(registerNango as any, input);

    expect(registerNango.post).toHaveBeenCalledWith({
      endpoint: '/ex/jira/cloud-123/rest/api/3/webhook',
      data: {
        url: webhookResponse.url,
        webhooks: [
          {
            events: webhookResponse.events,
            jqlFilter: webhookResponse.jqlFilter,
            fieldIdsFilter: webhookResponse.fieldIdsFilter,
          },
        ],
      },
    });
    expect(created.id).toBe('72');

    const updateNango = createNango({
      put: vi.fn().mockResolvedValue({ data: { expirationDate: webhookResponse.expirationDate } }),
    });
    const updated = await updateWebhook.exec(updateNango as any, { webhookId: 72 });

    expect(updateNango.put).toHaveBeenCalledWith({
      endpoint: '/ex/jira/cloud-123/rest/api/3/webhook/refresh',
      data: { webhookIds: [72] },
      retries: 3,
    });
    expect(updated).toEqual({ success: true, webhookId: '72', expirationDate: webhookResponse.expirationDate });
  });

  it('gets and deletes webhooks by id', async () => {
    const getNango = createNango({
      get: vi.fn().mockResolvedValue({ data: { values: [webhookResponse] } }),
    });

    const webhook = await getWebhook.exec(getNango as any, { webhookId: '72' });

    expect(getNango.get).toHaveBeenCalledWith({
      endpoint: '/ex/jira/cloud-123/rest/api/3/webhook',
      retries: 3,
    });
    expect(webhook.id).toBe('72');

    const deleteNango = createNango({
      delete: vi.fn().mockResolvedValue({ data: undefined }),
    });

    const deleted = await deleteWebhook.exec(deleteNango as any, { webhookId: 72 });

    expect(deleteNango.delete).toHaveBeenCalledWith({
      endpoint: '/ex/jira/cloud-123/rest/api/3/webhook',
      data: { webhookIds: [72] },
      retries: 3,
    });
    expect(deleted).toEqual({ success: true, webhookId: '72' });
  });
});
