import { createSync } from 'nango';
import { z } from 'zod';

const RecallRecording = z
    .object({
        id: z.string(),
        title: z.string().nullable().optional(),
        status: z.unknown().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
        completed_at: z.string().nullable().optional(),
        transcript_text: z.string().nullable().optional()
    })
    .passthrough();

const ListRecordingsResponse = z.object({
    next: z.string().nullable(),
    previous: z.string().nullable().optional(),
    results: z.array(RecallRecording)
});

const sync = createSync({
    description: 'Poll Recall recordings and emit RecallRecording records for Relayfile ingestion.',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    models: {
        RecallRecording
    },
    endpoints: [{ method: 'GET', path: '/recall/recordings', group: 'Recall' }],
    exec: async (nango) => {
        let endpoint = '/api/v1/recording/';

        while (endpoint) {
            const response = await nango.get({
                endpoint,
                retries: 3
            });
            const page = ListRecordingsResponse.parse(response.data);

            if (page.results.length > 0) {
                await nango.batchSave(page.results, 'RecallRecording');
            }

            endpoint = nextEndpointPath(page.next);
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;

function nextEndpointPath(next: string | null): string {
    if (!next) {
        return '';
    }
    try {
        const url = new URL(next);
        return `${url.pathname}${url.search}`;
    } catch {
        return next;
    }
}
