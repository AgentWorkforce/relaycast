import { createOnEvent } from 'nango';

const stopWebhooks = createOnEvent({
    event: 'pre-connection-deletion',
    description: 'Stop Gmail watch subscription before the connection is deleted.',
    version: '1.0.0',

    exec: async (nango): Promise<void> => {
        try {
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/stop
            await nango.post({
                endpoint: '/gmail/v1/users/me/stop',
                retries: 3
            });
            await nango.log('Google Mail webhook cleanup stopped the mailbox watch subscription.');
        } catch (error) {
            await nango.log(`Google Mail webhook cleanup could not stop mailbox watch subscription: ${String(error)}`, { level: 'warn' });
        }
    }
});

export default stopWebhooks;
