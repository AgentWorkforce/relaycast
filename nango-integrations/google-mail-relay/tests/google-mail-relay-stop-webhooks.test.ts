import { describe, expect, it, vi } from 'vitest';

import stopWebhooks from '../on-events/stop-webhooks.js';

describe('google-mail-relay stop-webhooks on-event', () => {
    it('calls stop-watch action before deleting the connection', async () => {
        const nango = {
            connectionId: 'conn-google-mail-123',
            post: vi.fn().mockResolvedValue({}),
            log: vi.fn()
        };

        await stopWebhooks.exec(nango as never);

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/gmail/v1/users/me/stop',
            retries: 3
        });
        expect(nango.log).toHaveBeenCalledWith('Google Mail webhook cleanup stopped the mailbox watch subscription.');
    });

    it('does not block deletion when stop-watch fails', async () => {
        const nango = {
            connectionId: 'conn-google-mail-123',
            post: vi.fn().mockRejectedValue(new Error('stop failed')),
            log: vi.fn()
        };

        await stopWebhooks.exec(nango as never);

        expect(nango.log).toHaveBeenCalledWith(expect.stringContaining('could not stop mailbox watch subscription'), { level: 'warn' });
    });
});
