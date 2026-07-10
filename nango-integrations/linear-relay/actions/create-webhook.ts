import { createAction } from 'nango';
import { z } from 'zod';
import {
    CreateWebhookInput,
    CreateWebhookOutput,
    LinearWebhook,
    normalizeWebhook,
    requireLinearData,
    type LinearGraphqlResponse
} from './webhook-utils.js';

const CREATE_WEBHOOK_MUTATION = `
  mutation CreateWebhook($input: WebhookCreateInput!) {
    webhookCreate(input: $input) {
      success
      webhook {
        id
        url
        enabled
        team {
          id
          name
        }
        creator {
          name
        }
      }
    }
  }
`;

interface CreateWebhookData {
    webhookCreate?: {
        success?: boolean;
        webhook?: z.input<typeof LinearWebhook> | null;
    } | null;
}

const action = createAction({
    description: 'Creates a Linear webhook for a team or all public teams in the connected organization.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/linear/webhooks',
        group: 'Linear'
    },
    input: CreateWebhookInput,
    output: CreateWebhookOutput,
    scopes: ['admin'],

    exec: async (nango, input): Promise<z.infer<typeof CreateWebhookOutput>> => {
        const response = await nango.post({
            // https://linear.app/developers/webhooks#create-webhook-using-api
            endpoint: '/graphql',
            data: {
                query: CREATE_WEBHOOK_MUTATION,
                variables: {
                    input: {
                        url: input.url,
                        resourceTypes: input.resourceTypes,
                        ...(input.teamId ? { teamId: input.teamId } : {}),
                        ...(input.allPublicTeams ? { allPublicTeams: true } : {})
                    }
                }
            },
            retries: 3
        });

        const data = requireLinearData(
            nango,
            response.data as LinearGraphqlResponse<CreateWebhookData> | undefined,
            'create webhook'
        );
        const result = data.webhookCreate;
        if (!result?.success || !result.webhook) {
            throw new nango.ActionError({
                type: 'linear_webhook_create_failed',
                message: 'Linear webhookCreate returned success: false or no webhook.'
            });
        }

        return {
            success: true,
            webhook: normalizeWebhook(result.webhook)
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
