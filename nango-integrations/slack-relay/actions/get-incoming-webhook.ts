import { createAction } from 'nango';
import { z } from 'zod';
import { getIncomingWebhook, SlackIncomingWebhookMetadata, toIncomingWebhookMetadata } from './incoming-webhook-utils.js';

const action = createAction({
    description: 'Returns metadata for the Slack incoming webhook provisioned during OAuth without exposing the secret webhook URL.',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/slack/incoming-webhook',
        group: 'Slack'
    },
    input: z.void(),
    output: SlackIncomingWebhookMetadata,
    scopes: ['incoming-webhook'],

    exec: async (nango) => {
        return toIncomingWebhookMetadata(await getIncomingWebhook(nango));
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
