import { createAction } from 'nango';
import { z } from 'zod';
import {
    assertTelegramOk,
    TelegramSendMessageInput,
    TelegramSendMessageOutput,
    toTelegramSendMessagePayload
} from './telegram-utils.js';

const action = createAction({
    description: 'Send a Telegram Bot API message through the connected bot.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/telegram/messages',
        group: 'Telegram'
    },
    input: TelegramSendMessageInput,
    output: TelegramSendMessageOutput,

    exec: async (nango, input): Promise<z.infer<typeof TelegramSendMessageOutput>> => {
        const response = await nango.post({
            endpoint: '/sendMessage',
            data: toTelegramSendMessagePayload(input),
            retries: 3
        });
        const body = assertTelegramOk(nango, response.data, 'telegram_send_message_failed');
        const result = body['result'] && typeof body['result'] === 'object'
            ? body['result'] as Record<string, unknown>
            : {};
        const chat = result['chat'] && typeof result['chat'] === 'object'
            ? result['chat'] as Record<string, unknown>
            : {};

        return {
            ok: true,
            ...(typeof result['message_id'] === 'number' ? { messageId: result['message_id'] } : {}),
            ...(typeof chat['id'] === 'string' || typeof chat['id'] === 'number' ? { chatId: chat['id'] } : {}),
            raw: body
        };
    }
});

export default action;
