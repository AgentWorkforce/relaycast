import { describe, expect, it, vi } from 'vitest';

import listChannels from '../actions/list-channels.js';

function channel(id: string, name: string, overrides: Record<string, unknown> = {}) {
    return { id, name, is_private: false, is_member: true, ...overrides };
}

describe('slack-relay list-channels paging action', () => {
    it('honors limit for unfiltered requests and returns Slack next_cursor when more pages exist', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                channels: [channel('C1', 'general'), channel('C2', 'engineering')],
                response_metadata: { next_cursor: 'cursor-2' }
            }
        });

        const result = await listChannels.exec({ get } as any, { limit: 2 });

        expect(result).toEqual({
            channels: [
                { id: 'C1', name: 'general', is_private: false, is_member: true },
                { id: 'C2', name: 'engineering', is_private: false, is_member: true }
            ],
            nextCursor: 'cursor-2'
        });
        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/conversations.list',
                params: expect.objectContaining({ limit: 2 })
            })
        );
    });

    it('omits nextCursor when Slack returns an empty next_cursor', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                channels: [channel('C1', 'general')],
                response_metadata: { next_cursor: '' }
            }
        });

        const result = await listChannels.exec({ get } as any, { limit: 10 });

        expect(result).toEqual({
            channels: [{ id: 'C1', name: 'general', is_private: false, is_member: true }]
        });
    });

    it('filters by query across upstream pages and keeps nextCursor on a Slack page boundary', async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({
                data: {
                    channels: [channel('C1', 'proj-alpha'), channel('C2', 'random')],
                    response_metadata: { next_cursor: 'after-page-1' }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    channels: [channel('C3', 'proj-beta'), channel('C4', 'proj-gamma')],
                    response_metadata: { next_cursor: 'after-page-2' }
                }
            });

        const result = await listChannels.exec({ get } as any, { query: 'PROJ', limit: 2 });

        expect(result).toEqual({
            channels: [
                { id: 'C1', name: 'proj-alpha', is_private: false, is_member: true },
                { id: 'C3', name: 'proj-beta', is_private: false, is_member: true },
                { id: 'C4', name: 'proj-gamma', is_private: false, is_member: true }
            ],
            nextCursor: 'after-page-2'
        });
        expect(get).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                params: expect.objectContaining({ limit: 200 })
            })
        );
        expect(get).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                params: expect.objectContaining({ cursor: 'after-page-1' })
            })
        );
    });

    it('caps filtered upstream paging at MAX_UPSTREAM_PAGES and returns the boundary cursor', async () => {
        const get = vi.fn();
        for (let index = 1; index <= 10; index += 1) {
            get.mockResolvedValueOnce({
                data: {
                    channels: [channel(`C${index}`, `misc-${index}`)],
                    response_metadata: { next_cursor: index === 10 ? 'continue-here' : `cursor-${index}` }
                }
            });
        }

        const result = await listChannels.exec({ get } as any, { query: 'missing', limit: 5 });

        expect(result).toEqual({ channels: [], nextCursor: 'continue-here' });
        expect(get).toHaveBeenCalledTimes(10);
    });

    it('skips archived channels before returning a page', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                channels: [
                    channel('C1', 'old-project', { is_archived: true }),
                    channel('C2', 'active-project')
                ],
                response_metadata: { next_cursor: '' }
            }
        });

        const result = await listChannels.exec({ get } as any, { query: 'project', limit: 10 });

        expect(result.channels).toEqual([{ id: 'C2', name: 'active-project', is_private: false, is_member: true }]);
    });
});
