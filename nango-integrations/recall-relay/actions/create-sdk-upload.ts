import { createAction } from 'nango';
import { z } from 'zod';

const CreateSdkUploadInput = z
    .object({
        metadata: z.record(z.string(), z.unknown()).optional()
    })
    .optional();

const RecallSdkUpload = z
    .object({
        id: z.string(),
        recording_id: z.string(),
        upload_token: z.string(),
        status: z.unknown().optional(),
        created_at: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough();

const action = createAction({
    description: 'Creates a Recall Desktop SDK upload token.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/recall/create-upload',
        group: 'Recall'
    },
    input: CreateSdkUploadInput,
    output: RecallSdkUpload,
    scopes: [],

    exec: async (nango, input): Promise<z.infer<typeof RecallSdkUpload>> => {
        const parsedInput = await nango.zodValidateInput({ zodSchema: CreateSdkUploadInput, input });
        const response = await nango.post({
            endpoint: '/api/v1/sdk_upload/',
            data: parsedInput.data ?? {},
            retries: 3
        });

        return RecallSdkUpload.parse(response.data);
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
