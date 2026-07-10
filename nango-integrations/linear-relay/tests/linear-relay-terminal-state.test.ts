import { describe, expect, it, vi } from 'vitest';

import issueSync from '../syncs/fetch-active-issues.js';

function createNango(overrides: Record<string, unknown> = {}) {
  return {
    setMergingStrategy: vi.fn(),
    batchSave: vi.fn(),
    batchDelete: vi.fn(),
    getCheckpoint: vi.fn().mockResolvedValue(null),
    saveCheckpoint: vi.fn(),
    log: vi.fn(),
    post: vi.fn(),
    ...overrides
  };
}

describe('linear-relay terminal issue state syncs', () => {
  it('scheduled sync fetches terminal issues so missed webhooks still update Relayfile', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        data: {
          issues: {
            nodes: [
              {
                id: 'issue-123',
                identifier: 'AGE-8',
                title: 'Release Plan',
                description: null,
                state: { name: 'Done', type: 'done' },
                priority: 0,
                assignee: null,
                url: 'https://linear.app/acme/issue/AGE-8/release-plan',
                createdAt: '2026-05-15T10:00:00.000Z',
                updatedAt: '2026-05-15T12:00:00.000Z'
              }
            ],
            pageInfo: {
              hasNextPage: false,
              endCursor: null
            }
          }
        }
      }
    });
    const nango = createNango({ post });

    await issueSync.exec?.(nango as any);

    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        variables: expect.objectContaining({
          updatedAfter: '1970-01-01T00:00:00.000Z'
        })
      })
    }));
    const query = (post.mock.calls[0]?.[0] as { data?: { query?: string } }).data?.query ?? '';
    expect(query).not.toContain('nin: ["canceled", "done"]');
    expect(nango.batchSave).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'issue-123', state_name: 'Done' })],
      'LinearIssue'
    );
  });

  it('saves done issue webhooks instead of deleting the issue', async () => {
    const nango = createNango({
      post: vi.fn().mockResolvedValue({
        data: {
          data: {
            issue: {
              id: 'issue-123',
              identifier: 'AGE-8',
              title: 'Release Plan',
              description: null,
              state: { name: 'Done', type: 'done' },
              priority: 0,
              assignee: null,
              url: 'https://linear.app/acme/issue/AGE-8/release-plan',
              createdAt: '2026-05-15T10:00:00.000Z',
              updatedAt: '2026-05-15T12:00:00.000Z'
            }
          }
        }
      })
    });

    await issueSync.onWebhook?.(nango as any, {
      action: 'update',
      data: {
        id: 'issue-123'
      }
    });

    expect(nango.batchSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'issue-123',
          identifier: 'AGE-8',
          state_name: 'Done'
        })
      ],
      'LinearIssue'
    );
    expect(nango.batchDelete).not.toHaveBeenCalled();
  });

  it('still deletes issues for actual remove webhooks', async () => {
    const nango = createNango();

    await issueSync.onWebhook?.(nango as any, {
      action: 'remove',
      data: {
        id: 'issue-123'
      }
    });

    expect(nango.batchDelete).toHaveBeenCalledWith([{ id: 'issue-123' }], 'LinearIssue');
    expect(nango.batchSave).not.toHaveBeenCalled();
  });
});
