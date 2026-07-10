import { createAction } from 'nango';
import { z } from 'zod';
import {
    assertTelegramOk,
    TelegramBotApiActionInput,
    TelegramBotApiActionOutput
} from './telegram-utils.js';

const action = createAction({
    description: 'Call an allowlisted Telegram Bot API method through the connected bot.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/telegram/bot-api',
        group: 'Telegram'
    },
    input: TelegramBotApiActionInput,
    output: TelegramBotApiActionOutput,

    exec: async (nango, input): Promise<z.infer<typeof TelegramBotApiActionOutput>> => {
        const endpoint = `/${input.method}`;
        const response = input.httpMethod === 'GET'
            ? await nango.get({
                endpoint,
                ...(input.params ? { params: input.params } : {}),
                retries: 3
            })
            : await nango.post({
                endpoint,
                data: input.data ?? {},
                ...(input.params ? { params: input.params } : {}),
                retries: 3
            });
        const body = assertTelegramOk(nango, response.data, 'telegram_bot_api_failed');

        return {
            ok: true,
            result: body['result'],
            raw: body
        };
    }
});

export default action;
