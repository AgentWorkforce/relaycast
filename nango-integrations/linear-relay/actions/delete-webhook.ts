import { createAction } from 'nango';
import { z } from 'zod';
import { DeleteWebhookInput, DeleteWebhookOutput, requireLinearData, type LinearGraphqlResponse } from './webhook-utils.js';

const DELETE_WEBHOOK_MUTATION = `
  mutation DeleteWebhook($id: String!) {
    webhookDelete(id: $id) {
      success
    }
  }
`;

interface DeleteWebhookData {
    webhookDelete?: {
        success?: boolean;
    } | null;
}

const action = createAction({
    description: 'Deletes a Linear webhook by id.',
    version: '1.0.0',
    endpoint: {
        method: 'DELETE',
        path: '/linear/webhooks/{webhookId}',
        group: 'Linear'
    },
    input: DeleteWebhookInput,
    output: DeleteWebhookOutput,
    scopes: ['admin'],

    exec: async (nango, input): Promise<z.infer<typeof DeleteWebhookOutput>> => {
        const response = await nango.post({
            // https://linear.app/developers/webhooks#deleting-a-webhook
            endpoint: '/graphql',
            data: {
                query: DELETE_WEBHOOK_MUTATION,
                variables: { id: input.webhookId }
            },
            retries: 3
        });

        const data = requireLinearData(
            nango,
            response.data as LinearGraphqlResponse<DeleteWebhookData> | undefined,
            'delete webhook'
        );
        if (!data.webhookDelete?.success) {
            throw new nango.ActionError({
                type: 'linear_webhook_delete_failed',
                message: 'Linear webhookDelete returned success: false.'
            });
        }

        return {
            success: true,
            webhookId: input.webhookId
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
