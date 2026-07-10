import { describe, expect, it, vi } from 'vitest';

import listUsers from '../actions/list-users.js';

function user(id: string, name: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name,
        real_name: name,
        profile: { display_name: name, email: `${name}@example.test` },
        ...overrides
    };
}

describe('slack-relay list-users paging action', () => {
    it('honors limit and returns Slack next_cursor when more pages exist', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                members: [user('U1', 'ben'), user('U2', 'amy')],
                response_metadata: { next_cursor: 'cursor-2' }
            }
        });

        const result = await listUsers.exec({ get } as any, { limit: 2 });

        expect(result.users.map((entry) => entry.id)).toEqual(['U1', 'U2']);
        expect(result.nextCursor).toBe('cursor-2');
        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/users.list',
                params: expect.objectContaining({ limit: 2 })
            })
        );
    });

    it('filters query across names, display names, and email without slicing mid-page', async () => {
        const get = vi
            .fn()
            .mockResolvedValueOnce({
                data: {
                    members: [user('U1', 'ben'), user('U2', 'amy')],
                    response_metadata: { next_cursor: 'after-page-1' }
                }
            })
            .mockResolvedValueOnce({
                data: {
                    members: [
                        user('U3', 'ops', { profile: { display_name: 'Benjamin', email: 'ops@example.test' } }),
                        user('U4', 'support', { profile: { display_name: 'Support', email: 'ben@work.test' } })
                    ],
                    response_metadata: { next_cursor: 'after-page-2' }
                }
            });

        const result = await listUsers.exec({ get } as any, { query: 'ben', limit: 2 });

        expect(result.users.map((entry) => entry.id)).toEqual(['U1', 'U3', 'U4']);
        expect(result.nextCursor).toBe('after-page-2');
        expect(get).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                params: expect.objectContaining({ limit: 200 })
            })
        );
    });

    it('caps filtered upstream paging at MAX_UPSTREAM_PAGES and returns the boundary cursor', async () => {
        const get = vi.fn();
        for (let index = 1; index <= 10; index += 1) {
            get.mockResolvedValueOnce({
                data: {
                    members: [user(`U${index}`, `person-${index}`)],
                    response_metadata: { next_cursor: index === 10 ? 'continue-here' : `cursor-${index}` }
                }
            });
        }

        const result = await listUsers.exec({ get } as any, { query: 'missing', limit: 3 });

        expect(result).toEqual({ users: [], nextCursor: 'continue-here' });
        expect(get).toHaveBeenCalledTimes(10);
    });
});
