import { describe, expect, it, vi } from 'vitest';

import deleteWebhook from '../actions/delete-webhook.js';
import botApi from '../actions/bot-api.js';
import sendMessage from '../actions/send-message.js';
import setWebhook from '../actions/set-webhook.js';
import { TelegramBotApiMethod } from '../actions/telegram-utils.js';

function createNango(overrides: Record<string, unknown> = {}) {
    class ActionError extends Error {
        type?: string;

        constructor({ message, type }: { message: string; type?: string }) {
            super(message);
            this.name = 'ActionError';
            this.type = type;
        }
    }

    return {
        ActionError,
        post: vi.fn(),
        ...overrides
    };
}

describe('telegram-relay actions', () => {
    it('sends messages through Telegram sendMessage', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    ok: true,
                    result: {
                        message_id: 42,
                        chat: { id: 12345 }
                    }
                }
            })
        });

        await expect(
            sendMessage.exec(nango as any, {
                chatId: 12345,
                text: 'Hello from Cloud',
                parseMode: 'MarkdownV2',
                replyToMessageId: 41
            })
        ).resolves.toMatchObject({
            ok: true,
            messageId: 42,
            chatId: 12345
        });

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/sendMessage',
            data: {
                chat_id: 12345,
                text: 'Hello from Cloud',
                parse_mode: 'MarkdownV2',
                reply_to_message_id: 41
            },
            retries: 3
        });
    });

    it('configures and deletes webhooks without exposing a bot token', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    ok: true,
                    result: true,
                    description: 'Webhook was set'
                }
            })
        });

        await expect(
            setWebhook.exec(nango as any, {
                url: 'https://cloud.example/api/v1/webhooks/telegram/conn_123',
                secretToken: 'derived-secret',
                allowedUpdates: ['message'],
                dropPendingUpdates: true
            })
        ).resolves.toEqual({
            ok: true,
            result: true,
            description: 'Webhook was set'
        });

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/setWebhook',
            data: {
                url: 'https://cloud.example/api/v1/webhooks/telegram/conn_123',
                secret_token: 'derived-secret',
                allowed_updates: ['message'],
                drop_pending_updates: true
            },
            retries: 3
        });

        await deleteWebhook.exec(nango as any, { dropPendingUpdates: false });
        expect(nango.post).toHaveBeenLastCalledWith({
            endpoint: '/deleteWebhook',
            data: { drop_pending_updates: false },
            retries: 3
        });
    });

    it('surfaces Telegram API failures as action errors', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    ok: false,
                    description: 'Bad Request: chat not found'
                }
            })
        });

        await expect(
            sendMessage.exec(nango as any, { chatId: 12345, text: 'Hello' })
        ).rejects.toMatchObject({
            name: 'ActionError',
            type: 'telegram_send_message_failed',
            message: 'Bad Request: chat not found'
        });
    });

    it('calls rich Telegram Bot API methods through the generic allowlisted action', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    ok: true,
                    result: true
                }
            })
        });

        await expect(
            botApi.exec(nango as any, {
                method: 'setMyCommands',
                data: {
                    commands: [
                        { command: 'review', description: 'Start a review' },
                        { command: 'status', description: 'Show status' }
                    ]
                }
            })
        ).resolves.toEqual({
            ok: true,
            result: true,
            raw: { ok: true, result: true }
        });

        await botApi.exec(nango as any, {
            method: 'setChatMenuButton',
            data: {
                menu_button: {
                    type: 'web_app',
                    text: 'Open bot builder',
                    web_app: { url: 'https://cloud.example/telegram' }
                }
            }
        });

        await botApi.exec(nango as any, {
            method: 'answerInlineQuery',
            data: {
                inline_query_id: 'inline-1',
                results: [
                    {
                        type: 'article',
                        id: 'run',
                        title: 'Run workflow',
                        input_message_content: { message_text: 'Run workflow' }
                    }
                ]
            }
        });

        await botApi.exec(nango as any, {
            method: 'answerCallbackQuery',
            data: {
                callback_query_id: 'callback-1',
                text: 'Queued'
            }
        });

        await botApi.exec(nango as any, {
            method: 'setMessageReaction',
            data: {
                chat_id: 12345,
                message_id: 42,
                reaction: [{ type: 'emoji', emoji: '\u{1F44D}' }]
            }
        });

        expect(nango.post).toHaveBeenNthCalledWith(1, {
            endpoint: '/setMyCommands',
            data: {
                commands: [
                    { command: 'review', description: 'Start a review' },
                    { command: 'status', description: 'Show status' }
                ]
            },
            params: undefined,
            retries: 3
        });
        expect(nango.post).toHaveBeenNthCalledWith(2, {
            endpoint: '/setChatMenuButton',
            data: {
                menu_button: {
                    type: 'web_app',
                    text: 'Open bot builder',
                    web_app: { url: 'https://cloud.example/telegram' }
                }
            },
            params: undefined,
            retries: 3
        });
        expect(nango.post).toHaveBeenNthCalledWith(3, expect.objectContaining({
            endpoint: '/answerInlineQuery'
        }));
        expect(nango.post).toHaveBeenNthCalledWith(4, expect.objectContaining({
            endpoint: '/answerCallbackQuery'
        }));
        expect(nango.post).toHaveBeenNthCalledWith(5, expect.objectContaining({
            endpoint: '/setMessageReaction'
        }));
    });

    it('does not allow proxying managed bot token operations', () => {
        expect(TelegramBotApiMethod.safeParse('getManagedBotToken').success).toBe(false);
        expect(TelegramBotApiMethod.safeParse('replaceManagedBotToken').success).toBe(false);
    });
});
