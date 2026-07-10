import { createAction } from 'nango';
import { z } from 'zod';
import {
    assertTelegramOk,
    TelegramDeleteWebhookInput,
    TelegramSetWebhookOutput,
    toTelegramDeleteWebhookPayload
} from './telegram-utils.js';

const action = createAction({
    description: 'Remove the connected Telegram bot webhook.',
    version: '1.0.0',
    endpoint: {
        method: 'DELETE',
        path: '/telegram/webhook',
        group: 'Telegram'
    },
    input: TelegramDeleteWebhookInput,
    output: TelegramSetWebhookOutput,

    exec: async (nango, input): Promise<z.infer<typeof TelegramSetWebhookOutput>> => {
        const response = await nango.post({
            endpoint: '/deleteWebhook',
            data: toTelegramDeleteWebhookPayload(input),
            retries: 3
        });
        const body = assertTelegramOk(nango, response.data, 'telegram_delete_webhook_failed');

        return {
            ok: true,
            ...(typeof body['result'] === 'boolean' ? { result: body['result'] } : {}),
            ...(typeof body['description'] === 'string' ? { description: body['description'] } : {})
        };
    }
});

export default action;
