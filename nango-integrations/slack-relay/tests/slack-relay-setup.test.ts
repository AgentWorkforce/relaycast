import { describe, expect, it, vi } from 'vitest';

import setup from '../on-events/setup.js';

const EXPECTED_WEBHOOK_SUBSCRIPTIONS = [
    'message',
    'app_mention',
    'message.channels',
    'message.groups',
    'message.im',
    'message.mpim'
];

function createNango(overrides: Record<string, unknown> = {}) {
    return {
        getMetadata: vi.fn().mockResolvedValue({}),
        setMetadata: vi.fn(),
        log: vi.fn(),
        ...overrides
    };
}

describe('slack-relay setup on-event', () => {
    it('sets connection webhook subscription metadata after connection creation', async () => {
        const nango = createNango();

        await setup.exec(nango as any);

        expect(nango.setMetadata).toHaveBeenCalledWith({
            webhookSubscriptions: EXPECTED_WEBHOOK_SUBSCRIPTIONS
        });
        expect(nango.log).toHaveBeenCalledWith(
            'Slack connection metadata initialized with 6 webhook subscription keys.'
        );
    });

    it('preserves existing metadata and merges subscription keys deterministically', async () => {
        const nango = createNango({
            getMetadata: vi.fn().mockResolvedValue({
                lookbackDays: 30,
                webhookSubscriptions: ['message', 'custom.event']
            })
        });

        await setup.exec(nango as any);

        expect(nango.setMetadata).toHaveBeenCalledWith({
            lookbackDays: 30,
            webhookSubscriptions: [
                'message',
                'custom.event',
                'app_mention',
                'message.channels',
                'message.groups',
                'message.im',
                'message.mpim'
            ]
        });
    });
});
