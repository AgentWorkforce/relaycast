import { describe, expect, it, vi } from 'vitest';

import fetchRecordings from '../syncs/fetch-recordings.js';
import fetchTranscripts from '../syncs/fetch-transcripts.js';

describe('recall-relay syncs', () => {
    it('fetches Recall recordings and saves RecallRecording records', async () => {
        const nango = {
            get: vi.fn().mockResolvedValue({
                data: {
                    next: null,
                    previous: null,
                    results: [{ id: 'recording_1', status: { code: 'done' } }]
                }
            }),
            batchSave: vi.fn()
        };

        await fetchRecordings.exec(nango as any);

        expect(nango.get).toHaveBeenCalledWith({
            endpoint: '/api/v1/recording/',
            retries: 3
        });
        expect(nango.batchSave).toHaveBeenCalledWith(
            [{ id: 'recording_1', status: { code: 'done' } }],
            'RecallRecording'
        );
    });

    it('fetches Recall transcripts and flattens transcript_text', async () => {
        const nango = {
            get: vi.fn().mockResolvedValue({
                data: {
                    next: null,
                    previous: null,
                    results: [
                        {
                            id: 'transcript_1',
                            recording: { id: 'recording_1' },
                            transcript: [{ text: 'Hello' }, { text: 'world' }]
                        }
                    ]
                }
            }),
            batchSave: vi.fn()
        };

        await fetchTranscripts.exec(nango as any);

        expect(nango.get).toHaveBeenCalledWith({
            endpoint: '/api/v1/transcript/',
            retries: 3
        });
        expect(nango.batchSave).toHaveBeenCalledWith(
            [
                {
                    id: 'transcript_1',
                    recording: { id: 'recording_1' },
                    recording_id: 'recording_1',
                    transcript: [{ text: 'Hello' }, { text: 'world' }],
                    transcript_text: 'Hello\nworld'
                }
            ],
            'RecallTranscript'
        );
    });
});
