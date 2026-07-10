import { createSync } from 'nango';
import { z } from 'zod';
import { assertTelegramOk } from '../actions/telegram-utils.js';

const TelegramBotConfig = z.object({
    id: z.string(),
    updatedAt: z.string(),
    botId: z.string(),
    username: z.string(),
    firstName: z.string(),
    canJoinGroups: z.boolean(),
    canReadAllGroupMessages: z.boolean(),
    supportsInlineQueries: z.boolean(),
    canConnectToBusiness: z.boolean(),
    hasMainWebApp: z.boolean(),
    commands: z.array(z.record(z.string(), z.unknown())),
    menuButton: z.record(z.string(), z.unknown()).nullable(),
    webhookInfo: z.record(z.string(), z.unknown()).nullable(),
    name: z.record(z.string(), z.unknown()).nullable(),
    description: z.record(z.string(), z.unknown()).nullable(),
    shortDescription: z.record(z.string(), z.unknown()).nullable(),
    raw: z.record(z.string(), z.unknown())
});

type TelegramBotConfigRecord = z.infer<typeof TelegramBotConfig>;

type NangoForBotConfig = {
    get: (input: { endpoint: string; params?: Record<string, string>; retries?: number }) => Promise<{ data: unknown }>;
    log: (message: string, options?: { level?: 'debug' | 'info' | 'warn' | 'error' }) => Promise<void>;
    ActionError: new (input: { type: string; message: string }) => Error;
};

async function optionalTelegramResult(
    nango: NangoForBotConfig,
    endpoint: string,
    fallback: unknown
): Promise<unknown> {
    try {
        const response = await nango.get({ endpoint, retries: 3 });
        const body = assertTelegramOk(nango, response.data, `telegram_${endpoint.slice(1)}_failed`);
        return body['result'] ?? fallback;
    } catch (error) {
        await nango.log(`Telegram ${endpoint} snapshot failed: ${error instanceof Error ? error.message : String(error)}`, {
            level: 'warn'
        });
        return fallback;
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
    const record = asRecord(value);
    return Object.keys(record).length > 0 ? record : null;
}

function asCommandList(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value)
        ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
}

const sync = createSync({
    description: 'Snapshots Telegram bot profile, commands, menu button, webhook, and inline-mode metadata.',
    version: '1.0.0',
    endpoints: [{ method: 'GET', path: '/telegram-relay/bot-config', group: 'Telegram' }],
    frequency: 'every 12 hours',
    autoStart: false,
    syncType: 'full',
    metadata: z.void(),
    models: {
        TelegramBotConfig
    },

    exec: async (nango) => {
        const telegram = nango as unknown as NangoForBotConfig;
        const bot = asRecord(await optionalTelegramResult(telegram, '/getMe', {}));
        const commands = asCommandList(await optionalTelegramResult(telegram, '/getMyCommands', []));
        const menuButton = asRecordOrNull(await optionalTelegramResult(telegram, '/getChatMenuButton', null));
        const webhookInfo = asRecordOrNull(await optionalTelegramResult(telegram, '/getWebhookInfo', null));
        const name = asRecordOrNull(await optionalTelegramResult(telegram, '/getMyName', null));
        const description = asRecordOrNull(await optionalTelegramResult(telegram, '/getMyDescription', null));
        const shortDescription = asRecordOrNull(await optionalTelegramResult(telegram, '/getMyShortDescription', null));

        const record: TelegramBotConfigRecord = {
            id: 'bot',
            updatedAt: new Date().toISOString(),
            botId: typeof bot['id'] === 'number' || typeof bot['id'] === 'string' ? String(bot['id']) : '',
            username: typeof bot['username'] === 'string' ? bot['username'] : '',
            firstName: typeof bot['first_name'] === 'string' ? bot['first_name'] : '',
            canJoinGroups: bot['can_join_groups'] === true,
            canReadAllGroupMessages: bot['can_read_all_group_messages'] === true,
            supportsInlineQueries: bot['supports_inline_queries'] === true,
            canConnectToBusiness: bot['can_connect_to_business'] === true,
            hasMainWebApp: bot['has_main_web_app'] === true,
            commands,
            menuButton,
            webhookInfo,
            name,
            description,
            shortDescription,
            raw: {
                bot,
                commands,
                menuButton,
                webhookInfo,
                name,
                description,
                shortDescription
            }
        };

        await nango.batchSave([record], 'TelegramBotConfig');
    }
});

export default sync;
