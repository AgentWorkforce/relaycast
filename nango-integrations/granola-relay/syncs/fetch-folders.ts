import { createSync } from 'nango';
import { z } from 'zod';

const FolderSchema = z.object({
    id: z.string(),
    object: z.literal('folder'),
    name: z.string(),
    parent_folder_id: z.string().nullable()
});

const CheckpointSchema = z.object({
    cursor: z.string(),
    delete_tracking_started: z.boolean()
});

const ListFoldersResponseSchema = z.object({
    folders: z.array(FolderSchema),
    hasMore: z.boolean(),
    cursor: z.string().nullable()
});

const sync = createSync({
    description: 'Poll Granola folders frequently and reconcile deletions with full-refresh tracking.',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    checkpoint: CheckpointSchema,
    models: {
        GranolaFolder: FolderSchema
    },
    endpoints: [{ method: 'GET', path: '/granola/folders', group: 'Granola' }],
    exec: async (nango) => {
        const checkpoint = parseCheckpoint(await nango.getCheckpoint());

        if (!checkpoint.delete_tracking_started) {
            await nango.trackDeletesStart('GranolaFolder');
            await nango.saveCheckpoint({
                delete_tracking_started: true,
                cursor: checkpoint.cursor
            });
        }

        let cursor = normalizeString(checkpoint.cursor);

        while (true) {
            const params: Record<string, string> = {
                page_size: '30'
            };
            if (cursor) {
                params['cursor'] = cursor;
            }

            // https://docs.granola.ai/api-reference/list-folders
            const response = await nango.get({
                endpoint: '/v1/folders',
                params,
                retries: 3
            });
            const page = ListFoldersResponseSchema.parse(response.data);

            if (page.folders.length > 0) {
                await nango.batchSave(page.folders, 'GranolaFolder');
            }

            cursor = page.cursor ?? undefined;
            if (cursor) {
                await nango.saveCheckpoint({
                    delete_tracking_started: true,
                    cursor
                });
                continue;
            }

            await nango.trackDeletesEnd('GranolaFolder');
            await nango.saveCheckpoint({
                cursor: '',
                delete_tracking_started: false
            });
            return;
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;

function parseCheckpoint(input: unknown): z.infer<typeof CheckpointSchema> {
    const parsed = CheckpointSchema.safeParse(input);
    if (!parsed.success) {
        return { cursor: '', delete_tracking_started: false };
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
