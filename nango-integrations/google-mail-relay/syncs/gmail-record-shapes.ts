import { z } from 'zod';

export const GoogleMailAttachment = z.object({
    filename: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    attachmentId: z.string().optional(),
    partId: z.string().optional()
});

export const GoogleMailMessage = z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
    snippet: z.string().optional(),
    historyId: z.string(),
    internalDate: z.string(),
    sizeEstimate: z.number().optional(),
    subject: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    date: z.string().optional(),
    messageId: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.string().optional(),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    attachments: z.array(GoogleMailAttachment)
});

export const GoogleMailThreadMessage = z.object({
    id: z.string(),
    threadId: z.string(),
    labelIds: z.array(z.string()).optional(),
    snippet: z.string().optional(),
    historyId: z.string().optional(),
    internalDate: z.string().optional(),
    sizeEstimate: z.number().optional(),
    subject: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    date: z.string().optional()
});

export const GoogleMailThread = z.object({
    id: z.string(),
    historyId: z.string(),
    snippet: z.string().optional(),
    messageIds: z.array(z.string()),
    messageCount: z.number(),
    messages: z.array(GoogleMailThreadMessage).optional()
});

type GmailPayloadPart = {
    partId?: unknown;
    mimeType?: unknown;
    filename?: unknown;
    headers?: unknown;
    body?: unknown;
    parts?: unknown;
};

type ExtractedBody = {
    bodyText: string | undefined;
    bodyHtml: string | undefined;
    attachments: z.infer<typeof GoogleMailAttachment>[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value.filter((entry): entry is string => typeof entry === 'string');
    return strings.length > 0 ? strings : undefined;
}

function omitUndefined<T extends Record<string, unknown>>(record: T): T {
    return Object.fromEntries(
        Object.entries(record).filter(([, value]) => value !== undefined)
    ) as T;
}

function parseHeader(payload: Record<string, unknown> | null, headerName: string): string | undefined {
    const headers = Array.isArray(payload?.['headers']) ? payload['headers'] : [];
    const found = headers.find((entry) => {
        const header = asRecord(entry);
        return typeof header?.['name'] === 'string' && header['name'].toLowerCase() === headerName.toLowerCase();
    });
    const value = asRecord(found)?.['value'];
    return typeof value === 'string' ? value : undefined;
}

function readFlattenedHeader(
    record: Record<string, unknown>,
    payload: Record<string, unknown> | null,
    headerName: string,
    field: string
): string | undefined {
    return parseHeader(payload, headerName) ?? readString(record, field);
}

function decodeBase64Url(value: string): string {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function collectParts(part: GmailPayloadPart, collected: { textParts: string[]; htmlParts: string[]; attachments: z.infer<typeof GoogleMailAttachment>[] }): void {
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const filename = typeof part.filename === 'string' ? part.filename : '';
    const body = asRecord(part.body);
    const data = typeof body?.['data'] === 'string' ? body['data'] : undefined;
    const partId = typeof part.partId === 'string' ? part.partId : undefined;
    const attachmentId = typeof body?.['attachmentId'] === 'string' ? body['attachmentId'] : undefined;
    const size = typeof body?.['size'] === 'number' ? body['size'] : undefined;

    if (data && mimeType === 'text/plain') {
        collected.textParts.push(decodeBase64Url(data));
    } else if (data && mimeType === 'text/html') {
        collected.htmlParts.push(decodeBase64Url(data));
    } else if (filename || attachmentId) {
        collected.attachments.push(omitUndefined({
            ...(filename && { filename }),
            ...(mimeType && { mimeType }),
            size,
            attachmentId,
            partId
        }));
    }

    if (Array.isArray(part.parts)) {
        for (const child of part.parts) {
            const childPart = asRecord(child);
            if (childPart) {
                collectParts(childPart, collected);
            }
        }
    }
}

function extractBodies(record: Record<string, unknown>): ExtractedBody {
    const payload = asRecord(record['payload']);
    const collected = {
        textParts: [] as string[],
        htmlParts: [] as string[],
        attachments: [] as z.infer<typeof GoogleMailAttachment>[]
    };

    if (payload) {
        collectParts(payload, collected);
    }

    return {
        bodyText: collected.textParts.length > 0 ? collected.textParts.join('\n\n') : undefined,
        bodyHtml: collected.htmlParts.length > 0 ? collected.htmlParts.join('\n\n') : undefined,
        attachments: collected.attachments
    };
}

export function compactGoogleMailMessageRecord(record: unknown): z.infer<typeof GoogleMailMessage> {
    const raw = asRecord(record);
    if (!raw) {
        throw new Error('Expected Google Mail message record');
    }

    const payload = asRecord(raw['payload']);
    const extracted = extractBodies(raw);
    const normalized = {
        id: readString(raw, 'id'),
        threadId: readString(raw, 'threadId') ?? readString(raw, 'thread_id'),
        labelIds: readStringArray(raw['labelIds']),
        snippet: readString(raw, 'snippet'),
        historyId: readString(raw, 'historyId') ?? readString(raw, 'history_id'),
        internalDate: readString(raw, 'internalDate') ?? readString(raw, 'internal_date'),
        ...(typeof raw['sizeEstimate'] === 'number' && { sizeEstimate: raw['sizeEstimate'] }),
        subject: readFlattenedHeader(raw, payload, 'Subject', 'subject'),
        from: readFlattenedHeader(raw, payload, 'From', 'from'),
        to: readFlattenedHeader(raw, payload, 'To', 'to'),
        cc: readFlattenedHeader(raw, payload, 'Cc', 'cc'),
        bcc: readFlattenedHeader(raw, payload, 'Bcc', 'bcc'),
        date: readFlattenedHeader(raw, payload, 'Date', 'date'),
        messageId: readFlattenedHeader(raw, payload, 'Message-ID', 'messageId'),
        inReplyTo: readFlattenedHeader(raw, payload, 'In-Reply-To', 'inReplyTo'),
        references: readFlattenedHeader(raw, payload, 'References', 'references'),
        body_text: payload ? extracted.bodyText : readString(raw, 'body_text'),
        body_html: payload ? extracted.bodyHtml : readString(raw, 'body_html'),
        attachments: payload
            ? extracted.attachments
            : Array.isArray(raw['attachments'])
              ? raw['attachments']
              : []
    };

    return GoogleMailMessage.parse(omitUndefined(normalized));
}

function compactGoogleMailThreadMessageRecord(record: unknown): z.infer<typeof GoogleMailThreadMessage> {
    const raw = asRecord(record);
    if (!raw) {
        throw new Error('Expected Google Mail thread message record');
    }

    const payload = asRecord(raw['payload']);
    const subject = readFlattenedHeader(raw, payload, 'Subject', 'subject');
    const from = readFlattenedHeader(raw, payload, 'From', 'from');
    const to = readFlattenedHeader(raw, payload, 'To', 'to');
    const date = readFlattenedHeader(raw, payload, 'Date', 'date');
    return GoogleMailThreadMessage.parse(omitUndefined({
        id: readString(raw, 'id'),
        threadId: readString(raw, 'threadId') ?? readString(raw, 'thread_id'),
        labelIds: readStringArray(raw['labelIds']),
        snippet: readString(raw, 'snippet'),
        historyId: readString(raw, 'historyId') ?? readString(raw, 'history_id'),
        internalDate: readString(raw, 'internalDate') ?? readString(raw, 'internal_date'),
        ...(typeof raw['sizeEstimate'] === 'number' && { sizeEstimate: raw['sizeEstimate'] }),
        ...(subject && { subject }),
        ...(from && { from }),
        ...(to && { to }),
        ...(date && { date })
    }));
}

export function compactGoogleMailThreadRecord(record: unknown): z.infer<typeof GoogleMailThread> {
    const raw = asRecord(record);
    if (!raw) {
        throw new Error('Expected Google Mail thread record');
    }

    const messages = Array.isArray(raw['messages'])
        ? raw['messages'].map((message) => compactGoogleMailThreadMessageRecord(message))
        : undefined;
    const messageIds = messages?.map((message) => message.id) ?? [];

    return GoogleMailThread.parse(omitUndefined({
        id: readString(raw, 'id'),
        historyId: readString(raw, 'historyId') ?? readString(raw, 'history_id'),
        snippet: readString(raw, 'snippet'),
        messageIds,
        messageCount: messageIds.length,
        messages
    }));
}
