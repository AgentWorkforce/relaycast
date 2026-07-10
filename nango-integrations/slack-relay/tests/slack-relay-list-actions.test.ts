import { describe, expect, it, vi } from 'vitest';

import listChannels from '../actions/list-channels.js';
import listUsers from '../actions/list-users.js';

describe('slack-relay list-users action', () => {
    it('returns active humans and filters bots, deleted, and Slackbot', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                members: [
                    {
                        id: 'U1',
                        name: 'benjamin',
                        real_name: 'Benjamin',
                        profile: { display_name: 'ben', email: 'ben@watchdog.no' }
                    },
                    { id: 'U2', name: 'botty', is_bot: true },
                    { id: 'U3', name: 'gone', deleted: true },
                    { id: 'USLACKBOT', name: 'slackbot' }
                ],
                response_metadata: { next_cursor: '' }
            }
        });

        const result = await listUsers.exec({ get } as any);

        expect(result.users).toEqual([
            { id: 'U1', name: 'benjamin', real_name: 'Benjamin', display_name: 'ben', email: 'ben@watchdog.no' }
        ]);
        expect(get).toHaveBeenCalledWith(expect.objectContaining({ endpoint: '/users.list' }));
    });
});

describe('slack-relay list-channels action', () => {
    it('returns non-archived channels from a manual cursor page', async () => {
        const get = vi.fn().mockResolvedValue({
            data: {
                channels: [
                    { id: 'C1', name: 'general', is_private: false, is_member: true },
                    { id: 'C2', name: 'old', is_archived: true },
                    { id: 'C3', name: 'secret', is_private: true, is_member: false }
                ],
                response_metadata: { next_cursor: '' }
            }
        });

        const result = await listChannels.exec({ get } as any);

        expect(result.channels).toEqual([
            { id: 'C1', name: 'general', is_private: false, is_member: true },
            { id: 'C3', name: 'secret', is_private: true, is_member: false }
        ]);
        expect(get).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/conversations.list',
                params: expect.objectContaining({ types: 'public_channel,private_channel' })
            })
        );
    });
});
