import { createSync } from 'nango';
import { z } from 'zod';

const NoteOwnerSchema = z.object({
    name: z.string().nullable(),
    email: z.string()
});

const FolderSchema = z.object({
    id: z.string(),
    object: z.literal('folder'),
    name: z.string(),
    parent_folder_id: z.string().nullable()
});

const CalendarInviteeSchema = z.object({
    email: z.string()
});

const CalendarEventSchema = z
    .object({
        event_title: z.string().nullable(),
        invitees: z.array(CalendarInviteeSchema),
        organiser: z.string().nullable(),
        calendar_event_id: z.string().nullable(),
        scheduled_start_time: z.string().nullable(),
        scheduled_end_time: z.string().nullable()
    })
    .nullable();

const TranscriptSpeakerSchema = z.object({
    source: z.string(),
    diarization_label: z.string().optional()
});

const TranscriptEntrySchema = z.object({
    speaker: TranscriptSpeakerSchema,
    text: z.string(),
    start_time: z.string(),
    end_time: z.string()
});

const NoteSchema = z.object({
    id: z.string(),
    object: z.literal('note'),
    title: z.string().nullable(),
    owner: NoteOwnerSchema,
    created_at: z.string(),
    updated_at: z.string(),
    web_url: z.string().url(),
    calendar_event: CalendarEventSchema,
    attendees: z.array(NoteOwnerSchema),
    folder_membership: z.array(FolderSchema),
    summary_text: z.string(),
    summary_markdown: z.string().nullable(),
    transcript: z.array(TranscriptEntrySchema).nullable()
});

const CheckpointSchema = z.object({
    updated_after: z.string(),
    cursor: z.string()
});

const ListNotesResponseSchema = z.object({
    notes: z.array(
        z.object({
            id: z.string(),
            updated_at: z.string()
        })
    ),
    hasMore: z.boolean(),
    cursor: z.string().nullable()
});

const sync = createSync({
    description: 'Poll Granola notes frequently and hydrate each changed note with full detail.',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    checkpoint: CheckpointSchema,
    models: {
        GranolaNote: NoteSchema
    },
    endpoints: [{ method: 'GET', path: '/granola/notes', group: 'Granola' }],
    exec: async (nango) => {
        const checkpoint = parseCheckpoint(await nango.getCheckpoint());
        const windowUpdatedAfter = normalizeString(checkpoint.updated_after);
        let cursor = normalizeString(checkpoint.cursor);
        let latestUpdatedAt = windowUpdatedAfter ?? '';

        while (true) {
            const params: Record<string, string> = {
                page_size: '30'
            };
            if (windowUpdatedAfter) {
                params['updated_after'] = windowUpdatedAfter;
            }
            if (cursor) {
                params['cursor'] = cursor;
            }

            // https://docs.granola.ai/api-reference/list-notes
            const listResponse = await nango.get({
                endpoint: '/v1/notes',
                params,
                retries: 3
            });
            const page = ListNotesResponseSchema.parse(listResponse.data);

            const records: Array<z.infer<typeof NoteSchema>> = [];
            for (const summary of page.notes) {
                // https://docs.granola.ai/api-reference/get-note
                const detailResponse = await nango.get({
                    endpoint: `/v1/notes/${encodeURIComponent(summary.id)}`,
                    retries: 3
                });

                const note = NoteSchema.parse(detailResponse.data);
                records.push(note);
                latestUpdatedAt = maxIsoTimestamp(latestUpdatedAt, note.updated_at);
            }

            if (records.length > 0) {
                await nango.batchSave(records, 'GranolaNote');
            }

            cursor = page.cursor ?? undefined;
            if (cursor) {
                const nextCheckpoint: z.infer<typeof CheckpointSchema> = {
                    updated_after: windowUpdatedAfter ?? '',
                    cursor
                };
                await nango.saveCheckpoint(nextCheckpoint);
                continue;
            }

            const finalizedCheckpoint: z.infer<typeof CheckpointSchema> = {
                updated_after: latestUpdatedAt ?? windowUpdatedAfter ?? '',
                cursor: ''
            };
            await nango.saveCheckpoint(finalizedCheckpoint);
            return;
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;

function parseCheckpoint(input: unknown): z.infer<typeof CheckpointSchema> {
    const parsed = CheckpointSchema.safeParse(input);
    if (!parsed.success) {
        return { updated_after: '', cursor: '' };
    }
    return parsed.data;
}

function normalizeString(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function maxIsoTimestamp(left: string, right: string | undefined): string {
    if (!right) {
        return left;
    }
    if (!left) {
        return right;
    }
    return left >= right ? left : right;
}
