import { createSync } from 'nango';
import { z } from 'zod';

const TranscriptSegment = z
    .object({
        text: z.string().optional(),
        words: z.string().optional(),
        content: z.string().optional()
    })
    .passthrough();

const RecallTranscript = z
    .object({
        id: z.string(),
        recording_id: z.string().optional(),
        recording: z.union([z.string(), z.object({ id: z.string() }).passthrough()]).nullable().optional(),
        transcript_text: z.string().nullable().optional(),
        transcript: z.union([z.string(), z.array(TranscriptSegment)]).nullable().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional()
    })
    .passthrough();

const ListTranscriptsResponse = z.object({
    next: z.string().nullable(),
    previous: z.string().nullable().optional(),
    results: z.array(RecallTranscript)
});

const sync = createSync({
    description: 'Poll Recall transcripts and emit RecallTranscript records with flattened transcript_text.',
    version: '1.0.0',
    frequency: 'every 5 minutes',
    autoStart: true,
    models: {
        RecallTranscript
    },
    endpoints: [{ method: 'GET', path: '/recall/transcripts', group: 'Recall' }],
    exec: async (nango) => {
        let endpoint = '/api/v1/transcript/';

        while (endpoint) {
            const response = await nango.get({
                endpoint,
                retries: 3
            });
            const page = ListTranscriptsResponse.parse(response.data);

            const records = page.results.map((record) => ({
                ...record,
                recording_id: record.recording_id ?? readRecordingId(record.recording),
                transcript_text: record.transcript_text ?? flattenTranscript(record.transcript)
            }));

            if (records.length > 0) {
                await nango.batchSave(records, 'RecallTranscript');
            }

            endpoint = nextEndpointPath(page.next);
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;

function readRecordingId(recording: unknown): string | undefined {
    if (typeof recording === 'string' && recording.trim()) {
        return recording.trim();
    }
    if (typeof recording === 'object' && recording !== null && 'id' in recording) {
        const id = (recording as { id?: unknown }).id;
        return typeof id === 'string' && id.trim() ? id.trim() : undefined;
    }
    return undefined;
}

function flattenTranscript(transcript: unknown): string | null | undefined {
    if (typeof transcript === 'string') {
        return transcript;
    }
    if (!Array.isArray(transcript)) {
        return undefined;
    }
    const parts = transcript
        .map((segment) => {
            if (typeof segment === 'string') {
                return segment;
            }
            if (typeof segment === 'object' && segment !== null) {
                const candidate = segment as { text?: unknown; words?: unknown; content?: unknown };
                return readString(candidate.text) ?? readString(candidate.words) ?? readString(candidate.content);
            }
            return undefined;
        })
        .filter((text): text is string => Boolean(text));
    return parts.length > 0 ? parts.join('\n') : undefined;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

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
