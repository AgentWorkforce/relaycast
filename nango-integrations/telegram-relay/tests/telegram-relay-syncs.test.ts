import { describe, expect, it, vi } from 'vitest';

import fetchUpdates from '../syncs/fetch-updates.js';

describe('telegram-relay syncs', () => {
    it('normalizes rich Telegram update types into Relayfile sync models', async () => {
        const nango = {
            getMetadata: vi.fn().mockResolvedValue({}),
            getCheckpoint: vi.fn().mockResolvedValue(null),
            saveCheckpoint: vi.fn(),
            post: vi.fn().mockResolvedValue({
                data: {
                    ok: true,
                    result: [
                        {
                            update_id: 100,
                            message: {
                                message_id: 42,
                                date: 1715600000,
                                chat: { id: 8587455921, type: 'private', username: 'khaliq' },
                                from: { id: 8587455921, username: 'khaliq' },
                                text: '/review',
                                reply_markup: {
                                    inline_keyboard: [[{ text: 'Approve', callback_data: 'review:approve' }]]
                                }
                            }
                        },
                        {
                            update_id: 101,
                            callback_query: {
                                id: 'cb-1',
                                from: { id: 8587455921 },
                                message: {
                                    message_id: 42,
                                    chat: { id: 8587455921, type: 'private', username: 'khaliq' },
                                    text: 'Choose'
                                },
                                chat_instance: 'instance',
                                data: 'review:approve'
                            }
                        },
                        {
                            update_id: 102,
                            inline_query: {
                                id: 'inline-1',
                                from: { id: 8587455921 },
                                query: 'deploy',
                                offset: '',
                                chat_type: 'sender'
                            }
                        },
                        {
                            update_id: 103,
                            message_reaction: {
                                chat: { id: 8587455921, type: 'private', username: 'khaliq' },
                                message_id: 42,
                                user: { id: 8587455921 },
                                old_reaction: [],
                                new_reaction: [{ type: 'emoji', emoji: '\u{1F44D}' }]
                            }
                        }
                    ]
                }
            }),
            batchSave: vi.fn(),
            log: vi.fn(),
            ActionError: class ActionError extends Error {
                type?: string;

                constructor({ message, type }: { message: string; type?: string }) {
                    super(message);
                    this.type = type;
                }
            }
        };

        await fetchUpdates.exec(nango as any);

        expect(nango.batchSave).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ id: '100', eventType: 'message' }),
                expect.objectContaining({ id: '101', eventType: 'callback_query' }),
                expect.objectContaining({ id: '102', eventType: 'inline_query' }),
                expect.objectContaining({ id: '103', eventType: 'message_reaction' })
            ]),
            'TelegramUpdate'
        );
        expect(nango.batchSave).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    id: '8587455921:42',
                    chatId: '8587455921',
                    messageId: '42',
                    text: '/review'
                })
            ]),
            'TelegramMessage'
        );
        expect(nango.batchSave).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'cb-1', data: 'review:approve' })],
            'TelegramCallbackQuery'
        );
        expect(nango.batchSave).toHaveBeenCalledWith(
            [expect.objectContaining({ id: 'inline-1', query: 'deploy', chatType: 'sender' })],
            'TelegramInlineQuery'
        );
        expect(nango.batchSave).toHaveBeenCalledWith(
            [expect.objectContaining({ id: '8587455921:42:103', userId: '8587455921' })],
            'TelegramReaction'
        );
        expect(nango.saveCheckpoint).toHaveBeenCalledWith({ offset: 104 });
    });
});
