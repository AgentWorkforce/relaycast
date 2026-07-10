import { randomUUID } from 'crypto';

export type GoogleCalendarWatchResourceType = 'events' | 'acl' | 'calendarList' | 'settings';

export type GoogleCalendarWatchChannel = {
    resourceType: GoogleCalendarWatchResourceType;
    calendarId?: string;
    channelId: string;
    resourceId: string;
    resourceUri: string;
    expiration?: string;
    token?: string;
    createdAt: string;
};

export type GoogleCalendarWatchPlan = {
    calendarIds: string[];
    includeAcls: boolean;
    includeCalendarList: boolean;
    includeSettings: boolean;
    channelToken?: string;
    ttlSeconds?: number;
};

export type GoogleCalendarWatchOptions = {
    webhookUrl: string;
    metadata?: Record<string, unknown>;
    connectionConfig?: Record<string, unknown>;
    envMap?: Map<string, string>;
};

type NangoCalendarWatchClient = {
    ActionError: new (input: { type: string; message: string }) => Error;
    post: (config: { endpoint: string; data: Record<string, unknown>; retries?: number }) => Promise<{ data: unknown; status: number }>;
    log: (message: string, options?: { level?: 'debug' | 'info' | 'warn' | 'error' }) => void | Promise<void>;
};

const CALENDAR_IDS_ENV_KEYS = ['GOOGLE_CALENDAR_WATCH_CALENDAR_IDS'] as const;
const WATCH_CALENDAR_LIST_ENV_KEYS = ['GOOGLE_CALENDAR_WATCH_CALENDAR_LIST'] as const;
const WATCH_SETTINGS_ENV_KEYS = ['GOOGLE_CALENDAR_WATCH_SETTINGS'] as const;
const WATCH_ACLS_ENV_KEYS = ['GOOGLE_CALENDAR_WATCH_ACLS'] as const;
const WATCH_TTL_SECONDS_ENV_KEYS = ['GOOGLE_CALENDAR_WATCH_TTL_SECONDS'] as const;
const WATCH_CHANNEL_TOKEN_ENV_KEYS = ['GOOGLE_CALENDAR_WATCH_CHANNEL_TOKEN'] as const;

export async function createGoogleCalendarWatchChannels(
    nango: NangoCalendarWatchClient,
    options: GoogleCalendarWatchOptions
): Promise<{ channels: GoogleCalendarWatchChannel[]; plan: GoogleCalendarWatchPlan }> {
    const metadata = options.metadata ?? {};
    const connectionConfig = options.connectionConfig ?? {};
    const envMap = options.envMap ?? new Map<string, string>();

    const plan = resolveGoogleCalendarWatchPlan(metadata, connectionConfig, envMap);
    const channels: GoogleCalendarWatchChannel[] = [];

    for (const calendarId of plan.calendarIds) {
        const channel = await watchEvents(nango, {
            webhookUrl: options.webhookUrl,
            calendarId,
            ...(plan.channelToken ? { channelToken: plan.channelToken } : {}),
            ...(plan.ttlSeconds ? { ttlSeconds: plan.ttlSeconds } : {})
        });
        channels.push(channel);

        if (plan.includeAcls) {
            channels.push(
                await watchAcl(nango, {
                    webhookUrl: options.webhookUrl,
                    calendarId,
                    ...(plan.channelToken ? { channelToken: plan.channelToken } : {}),
                    ...(plan.ttlSeconds ? { ttlSeconds: plan.ttlSeconds } : {})
                })
            );
        }
    }

    if (plan.includeCalendarList) {
        channels.push(
                await watchCalendarList(nango, {
                    webhookUrl: options.webhookUrl,
                    ...(plan.channelToken ? { channelToken: plan.channelToken } : {}),
                    ...(plan.ttlSeconds ? { ttlSeconds: plan.ttlSeconds } : {})
                })
            );
    }

    if (plan.includeSettings) {
        channels.push(
                await watchSettings(nango, {
                    webhookUrl: options.webhookUrl,
                    ...(plan.channelToken ? { channelToken: plan.channelToken } : {}),
                    ...(plan.ttlSeconds ? { ttlSeconds: plan.ttlSeconds } : {})
                })
            );
    }

    await nango.log(`Registered ${channels.length} Google Calendar watch channel(s).`);

    return { channels, plan };
}

export async function stopGoogleCalendarWatchChannels(
    nango: NangoCalendarWatchClient,
    channels: GoogleCalendarWatchChannel[]
): Promise<{ stopped: number; failed: number }> {
    let stopped = 0;
    let failed = 0;

    for (const channel of channels) {
        try {
            // https://developers.google.com/workspace/calendar/api/v3/reference/channels/stop
            await nango.post({
                endpoint: '/calendar/v3/channels/stop',
                data: {
                    id: channel.channelId,
                    resourceId: channel.resourceId,
                    ...(channel.token ? { token: channel.token } : {})
                },
                retries: 3
            });
            stopped += 1;
        } catch (error) {
            failed += 1;
            await nango.log(`Failed to stop Google Calendar channel ${channel.channelId}: ${formatError(error)}`, { level: 'warn' });
        }
    }

    return { stopped, failed };
}

export function resolveGoogleCalendarWatchPlan(
    metadata: Record<string, unknown>,
    connectionConfig: Record<string, unknown>,
    envMap: Map<string, string>
): GoogleCalendarWatchPlan {
    const calendarIds =
        readStringArray(metadata['googleCalendarWatchCalendarIds']) ??
        readStringArray(metadata['calendarIds']) ??
        readStringArray(connectionConfig['googleCalendarWatchCalendarIds']) ??
        readStringArray(connectionConfig['calendarIds']) ??
        parseCsvList(readEnvValue(envMap, CALENDAR_IDS_ENV_KEYS)) ??
        ['primary'];

    const includeCalendarList =
        readBoolean(metadata['googleCalendarWatchCalendarList']) ??
        readBoolean(metadata['watchCalendarList']) ??
        readBoolean(connectionConfig['googleCalendarWatchCalendarList']) ??
        readBoolean(connectionConfig['watchCalendarList']) ??
        parseBoolean(readEnvValue(envMap, WATCH_CALENDAR_LIST_ENV_KEYS)) ??
        false;

    const includeSettings =
        readBoolean(metadata['googleCalendarWatchSettings']) ??
        readBoolean(metadata['watchSettings']) ??
        readBoolean(connectionConfig['googleCalendarWatchSettings']) ??
        readBoolean(connectionConfig['watchSettings']) ??
        parseBoolean(readEnvValue(envMap, WATCH_SETTINGS_ENV_KEYS)) ??
        false;

    const includeAcls =
        readBoolean(metadata['googleCalendarWatchAcls']) ??
        readBoolean(metadata['watchAcls']) ??
        readBoolean(connectionConfig['googleCalendarWatchAcls']) ??
        readBoolean(connectionConfig['watchAcls']) ??
        parseBoolean(readEnvValue(envMap, WATCH_ACLS_ENV_KEYS)) ??
        false;

    const ttlSeconds =
        readNumber(metadata['googleCalendarWatchTtlSeconds']) ??
        readNumber(metadata['watchTtlSeconds']) ??
        readNumber(connectionConfig['googleCalendarWatchTtlSeconds']) ??
        readNumber(connectionConfig['watchTtlSeconds']) ??
        parseInteger(readEnvValue(envMap, WATCH_TTL_SECONDS_ENV_KEYS));

    const channelToken =
        readString(metadata['googleCalendarWatchChannelToken']) ??
        readString(metadata['watchChannelToken']) ??
        readString(connectionConfig['googleCalendarWatchChannelToken']) ??
        readString(connectionConfig['watchChannelToken']) ??
        readEnvValue(envMap, WATCH_CHANNEL_TOKEN_ENV_KEYS);

    return {
        calendarIds,
        includeAcls,
        includeCalendarList,
        includeSettings,
        ...(channelToken ? { channelToken } : {}),
        ...(ttlSeconds ? { ttlSeconds } : {})
    };
}

export function serializeWatchChannels(channels: GoogleCalendarWatchChannel[]): Array<Record<string, unknown>> {
    return channels.map((channel) => ({
        resourceType: channel.resourceType,
        ...(channel.calendarId ? { calendarId: channel.calendarId } : {}),
        channelId: channel.channelId,
        resourceId: channel.resourceId,
        resourceUri: channel.resourceUri,
        ...(channel.expiration ? { expiration: channel.expiration } : {}),
        ...(channel.token ? { token: channel.token } : {}),
        createdAt: channel.createdAt
    }));
}

export function parseWatchChannels(input: unknown): GoogleCalendarWatchChannel[] {
    if (!Array.isArray(input)) {
        return [];
    }

    const channels: GoogleCalendarWatchChannel[] = [];

    for (const candidate of input) {
        if (!isRecord(candidate)) {
            continue;
        }

        const resourceType = parseResourceType(candidate['resourceType']);
        const channelId = readString(candidate['channelId']);
        const resourceId = readString(candidate['resourceId']);
        const resourceUri = readString(candidate['resourceUri']);
        const createdAt = readString(candidate['createdAt']) ?? new Date().toISOString();

        if (!resourceType || !channelId || !resourceId || !resourceUri) {
            continue;
        }

        const calendarId = readString(candidate['calendarId']);
        const expiration = readString(candidate['expiration']);
        const token = readString(candidate['token']);

        channels.push({
            resourceType,
            ...(calendarId ? { calendarId } : {}),
            channelId,
            resourceId,
            resourceUri,
            ...(expiration ? { expiration } : {}),
            ...(token ? { token } : {}),
            createdAt
        });
    }

    return channels;
}

export function toWatchResourceUris(channels: GoogleCalendarWatchChannel[]): string[] {
    return Array.from(new Set(channels.map((channel) => channel.resourceUri)));
}

async function watchEvents(
    nango: NangoCalendarWatchClient,
    input: { webhookUrl: string; calendarId: string; channelToken?: string; ttlSeconds?: number }
): Promise<GoogleCalendarWatchChannel> {
    const payload = buildWatchPayload(input.webhookUrl, input.channelToken, input.ttlSeconds);

    // https://developers.google.com/workspace/calendar/api/v3/reference/events/watch
    const response = await nango.post({
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/watch`,
        data: payload,
        retries: 3
    });

    const watchResponse = parseWatchResponse(response.data, nango, 'events');

    return {
        resourceType: 'events',
        calendarId: input.calendarId,
        channelId: watchResponse.channelId,
        resourceId: watchResponse.resourceId,
        resourceUri: watchResponse.resourceUri,
        ...(watchResponse.expiration ? { expiration: watchResponse.expiration } : {}),
        ...(input.channelToken ? { token: input.channelToken } : {}),
        createdAt: new Date().toISOString()
    };
}

async function watchAcl(
    nango: NangoCalendarWatchClient,
    input: { webhookUrl: string; calendarId: string; channelToken?: string; ttlSeconds?: number }
): Promise<GoogleCalendarWatchChannel> {
    const payload = buildWatchPayload(input.webhookUrl, input.channelToken, input.ttlSeconds);

    // https://developers.google.com/workspace/calendar/api/v3/reference/acl/watch
    const response = await nango.post({
        endpoint: `/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/acl/watch`,
        data: payload,
        retries: 3
    });

    const watchResponse = parseWatchResponse(response.data, nango, 'acl');

    return {
        resourceType: 'acl',
        calendarId: input.calendarId,
        channelId: watchResponse.channelId,
        resourceId: watchResponse.resourceId,
        resourceUri: watchResponse.resourceUri,
        ...(watchResponse.expiration ? { expiration: watchResponse.expiration } : {}),
        ...(input.channelToken ? { token: input.channelToken } : {}),
        createdAt: new Date().toISOString()
    };
}

async function watchCalendarList(
    nango: NangoCalendarWatchClient,
    input: { webhookUrl: string; channelToken?: string; ttlSeconds?: number }
): Promise<GoogleCalendarWatchChannel> {
    const payload = buildWatchPayload(input.webhookUrl, input.channelToken, input.ttlSeconds);

    // https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/watch
    const response = await nango.post({
        endpoint: '/calendar/v3/users/me/calendarList/watch',
        data: payload,
        retries: 3
    });

    const watchResponse = parseWatchResponse(response.data, nango, 'calendarList');

    return {
        resourceType: 'calendarList',
        channelId: watchResponse.channelId,
        resourceId: watchResponse.resourceId,
        resourceUri: watchResponse.resourceUri,
        ...(watchResponse.expiration ? { expiration: watchResponse.expiration } : {}),
        ...(input.channelToken ? { token: input.channelToken } : {}),
        createdAt: new Date().toISOString()
    };
}

async function watchSettings(
    nango: NangoCalendarWatchClient,
    input: { webhookUrl: string; channelToken?: string; ttlSeconds?: number }
): Promise<GoogleCalendarWatchChannel> {
    const payload = buildWatchPayload(input.webhookUrl, input.channelToken, input.ttlSeconds);

    // https://developers.google.com/workspace/calendar/api/v3/reference/settings/watch
    const response = await nango.post({
        endpoint: '/calendar/v3/users/me/settings/watch',
        data: payload,
        retries: 3
    });

    const watchResponse = parseWatchResponse(response.data, nango, 'settings');

    return {
        resourceType: 'settings',
        channelId: watchResponse.channelId,
        resourceId: watchResponse.resourceId,
        resourceUri: watchResponse.resourceUri,
        ...(watchResponse.expiration ? { expiration: watchResponse.expiration } : {}),
        ...(input.channelToken ? { token: input.channelToken } : {}),
        createdAt: new Date().toISOString()
    };
}

function buildWatchPayload(webhookUrl: string, channelToken?: string, ttlSeconds?: number): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        id: randomUUID(),
        type: 'web_hook',
        address: webhookUrl
    };

    if (channelToken) {
        payload['token'] = channelToken;
    }

    if (ttlSeconds) {
        payload['params'] = {
            ttl: String(ttlSeconds)
        };
    }

    return payload;
}

function parseWatchResponse(
    data: unknown,
    nango: NangoCalendarWatchClient,
    resourceType: GoogleCalendarWatchResourceType
): { channelId: string; resourceId: string; resourceUri: string; expiration?: string } {
    if (!isRecord(data)) {
        throw new nango.ActionError({
            type: 'invalid_watch_response',
            message: `Google Calendar ${resourceType} watch response is not an object.`
        });
    }

    const channelId = readString(data['id']);
    const resourceId = readString(data['resourceId']);
    const resourceUri = readString(data['resourceUri']);
    const expiration = readString(data['expiration']) ?? (typeof data['expiration'] === 'number' ? String(data['expiration']) : undefined);

    if (!channelId || !resourceId || !resourceUri) {
        throw new nango.ActionError({
            type: 'invalid_watch_response',
            message: `Google Calendar ${resourceType} watch response is missing id/resourceId/resourceUri.`
        });
    }

    return {
        channelId,
        resourceId,
        resourceUri,
        ...(expiration ? { expiration } : {})
    };
}

function parseResourceType(value: unknown): GoogleCalendarWatchResourceType | null {
    if (value === 'events' || value === 'acl' || value === 'calendarList' || value === 'settings') {
        return value;
    }

    return null;
}

function readEnvValue(envMap: Map<string, string>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envMap.get(key);
        if (value && value.length > 0) {
            return value;
        }
    }

    return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        return parseBoolean(value);
    }

    return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
    if (!value) {
        return undefined;
    }

    const lowered = value.toLowerCase();
    if (lowered === 'true' || lowered === '1' || lowered === 'yes') {
        return true;
    }

    if (lowered === 'false' || lowered === '0' || lowered === 'no') {
        return false;
    }

    return undefined;
}

function readNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
    }

    if (typeof value === 'string') {
        return parseInteger(value);
    }

    return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }

    return parsed;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return items.length > 0 ? items : undefined;
}

function parseCsvList(value: string | undefined): string[] | undefined {
    if (!value) {
        return undefined;
    }

    const items = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return items.length > 0 ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
