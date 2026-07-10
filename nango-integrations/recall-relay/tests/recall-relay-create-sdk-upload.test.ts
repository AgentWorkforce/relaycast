import { describe, expect, it, vi } from 'vitest';

import createSdkUpload from '../actions/create-sdk-upload.js';

function createNango(responseData: unknown) {
    class ActionError extends Error {
        type?: string;

        constructor({ message, type }: { message: string; type?: string }) {
            super(message);
            this.name = 'ActionError';
            if (type !== undefined) this.type = type;
        }
    }

    return {
        ActionError,
        zodValidateInput: vi.fn().mockImplementation(({ input }) => Promise.resolve({ data: input ?? {} })),
        post: vi.fn().mockResolvedValue({ data: responseData })
    };
}

describe('recall-relay create-sdk-upload action', () => {
    it('posts an empty body to Recall SDK upload and returns the upload token response', async () => {
        const response = {
            id: 'upload_1',
            recording_id: 'recording_1',
            upload_token: 'token_1',
            status: { code: 'pending' },
            metadata: {}
        };
        const nango = createNango(response);

        const result = await createSdkUpload.exec(nango as any, {});

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/api/v1/sdk_upload/',
            data: {},
            retries: 3
        });
        expect(result).toEqual(response);
    });

    it('passes optional metadata through to Recall', async () => {
        const response = {
            id: 'upload_2',
            recording_id: 'recording_2',
            upload_token: 'token_2'
        };
        const nango = createNango(response);

        await createSdkUpload.exec(nango as any, { metadata: { meetingTitle: 'Demo' } });

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/api/v1/sdk_upload/',
            data: { metadata: { meetingTitle: 'Demo' } },
            retries: 3
        });
    });
});
