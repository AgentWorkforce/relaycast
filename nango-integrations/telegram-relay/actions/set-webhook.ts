import { createAction } from 'nango';
import { z } from 'zod';
import {
    assertTelegramOk,
    TelegramSetWebhookInput,
    TelegramSetWebhookOutput,
    toTelegramSetWebhookPayload
} from './telegram-utils.js';

const action = createAction({
    description: 'Configure the connected Telegram bot webhook URL.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/telegram/webhook',
        group: 'Telegram'
    },
    input: TelegramSetWebhookInput,
    output: TelegramSetWebhookOutput,

    exec: async (nango, input): Promise<z.infer<typeof TelegramSetWebhookOutput>> => {
        const response = await nango.post({
            endpoint: '/setWebhook',
            data: toTelegramSetWebhookPayload(input),
            retries: 3
        });
        const body = assertTelegramOk(nango, response.data, 'telegram_set_webhook_failed');

        return {
            ok: true,
            ...(typeof body['result'] === 'boolean' ? { result: body['result'] } : {}),
            ...(typeof body['description'] === 'string' ? { description: body['description'] } : {})
        };
    }
});

export default action;
