import { describe, expect, it, vi } from 'vitest';

import pageSync from '../syncs/fetch-pages.js';
import databaseSync from '../syncs/fetch-databases.js';

function titleProperty(title: string): Record<string, unknown> {
  return {
    Name: {
      type: 'title',
      title: [{ plain_text: title }],
    },
  };
}

describe('notion-relay archived state handling', () => {
  it('saves archived page metadata instead of deleting the page and content', async () => {
    const nango = {
      batchSave: vi.fn(),
      batchDelete: vi.fn(),
      log: vi.fn(),
      get: vi.fn().mockResolvedValue({
        data: {
          id: 'page-123',
          url: 'https://notion.so/page-123',
          last_edited_time: '2026-05-15T12:00:00.000Z',
          properties: titleProperty('Release Plan'),
          parent: { type: 'workspace', workspace: true },
          archived: true,
          in_trash: false,
        },
      }),
    };

    await pageSync.onWebhook?.(nango as any, {
      type: 'page.content_updated',
      entity: { id: 'page-123', type: 'page' },
    });

    expect(nango.batchSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'page-123',
          title: 'Release Plan',
          archived: true,
          in_trash: false,
        }),
      ],
      'NotionPage',
    );
    expect(nango.batchDelete).not.toHaveBeenCalled();
    expect(nango.get).toHaveBeenCalledTimes(1);
  });

  it('still deletes pages on actual Notion page.deleted events', async () => {
    const nango = {
      batchSave: vi.fn(),
      batchDelete: vi.fn(),
      log: vi.fn(),
      get: vi.fn(),
    };

    await pageSync.onWebhook?.(nango as any, {
      type: 'page.deleted',
      entity: { id: 'page-123', type: 'page' },
    });

    expect(nango.batchDelete).toHaveBeenCalledWith([{ id: 'page-123' }], 'NotionPage');
    expect(nango.batchDelete).toHaveBeenCalledWith([{ id: 'page-123' }], 'NotionPageContent');
    expect(nango.batchSave).not.toHaveBeenCalled();
  });

  it('saves archived database metadata instead of deleting the database', async () => {
    const nango = {
      batchSave: vi.fn(),
      batchDelete: vi.fn(),
      log: vi.fn(),
      get: vi.fn().mockResolvedValue({
        data: {
          id: 'database-123',
          url: 'https://notion.so/database-123',
          last_edited_time: '2026-05-15T12:00:00.000Z',
          title: [{ plain_text: 'Engineering' }],
          description: [],
          properties: { Status: {} },
          archived: true,
          in_trash: false,
        },
      }),
    };

    await databaseSync.onWebhook?.(nango as any, {
      type: 'database.schema_updated',
      entity: { id: 'database-123', type: 'database' },
    });

    expect(nango.batchSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'database-123',
          title: 'Engineering',
          archived: true,
          in_trash: false,
        }),
      ],
      'NotionDatabase',
    );
    expect(nango.batchDelete).not.toHaveBeenCalled();
  });

  it('preserves archived database metadata during scheduled syncs', async () => {
    async function* paginate() {
      yield [
        {
          id: 'database-123',
          url: 'https://notion.so/database-123',
          last_edited_time: '2026-05-15T12:00:00.000Z',
          title: [{ plain_text: 'Engineering' }],
          description: [],
          properties: { Status: {} },
          archived: true,
          in_trash: false,
        },
      ];
    }

    async function* listRecords() {
      yield {
        id: 'database-123',
        title: 'Engineering',
      };
    }

    const nango = {
      batchSave: vi.fn(),
      batchDelete: vi.fn(),
      getCheckpoint: vi.fn().mockResolvedValue(null),
      saveCheckpoint: vi.fn(),
      paginate: vi.fn().mockReturnValue(paginate()),
      listRecords: vi.fn().mockReturnValue(listRecords()),
      log: vi.fn(),
    };

    await databaseSync.exec(nango as any);

    expect(nango.batchSave).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'database-123',
          title: 'Engineering',
          archived: true,
          in_trash: false,
        }),
      ],
      'NotionDatabase',
    );
    expect(nango.batchDelete).not.toHaveBeenCalled();
  });
});
