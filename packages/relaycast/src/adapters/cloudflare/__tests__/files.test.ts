import { describe, expect, it } from 'vitest';
import { createCloudflareFileStorage } from '../files.js';
import type { CloudflareBindings } from '../../../env.js';

function createEnv(): CloudflareBindings {
  return {
    CF_ACCOUNT_ID: 'acct123',
    R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    R2_SECRET_ACCESS_KEY: 'secret-key',
    FILES_BUCKET_NAME: 'relaycast-gateway-files',
  } as CloudflareBindings;
}

describe('createCloudflareFileStorage', () => {
  it('presigns an upload URL against the R2 endpoint with a SigV4 query signature', async () => {
    const storage = createCloudflareFileStorage(createEnv());
    const { uploadUrl, expiresAt } = await storage.createUploadUrl({
      storageKey: 'ws_1/file_1/report.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    const url = new URL(uploadUrl);
    expect(url.host).toBe('acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/relaycast-gateway-files/ws_1/file_1/report.pdf');
    // Query-presigned: signature material lives in the query string.
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(Date.parse(expiresAt)).not.toBeNaN();
  });

  it('encodes special characters in the storage key per segment so the object key and signature stay correct', async () => {
    const storage = createCloudflareFileStorage(createEnv());
    // A user-supplied filename with `#`, `?`, `&`, and a space — `encodeURI`
    // would leave `#`/`?`/`&` intact and corrupt the key; per-segment
    // `encodeURIComponent` must escape them while keeping `/` separators.
    const downloadUrl = await storage.createDownloadUrl({
      storageKey: 'ws_1/file_2/q&a report#1?draft.csv',
    });

    const url = new URL(downloadUrl);
    // The `/` separators survive; the special chars are percent-encoded so the
    // path resolves to the intended object and nothing leaks into the query.
    expect(url.pathname).toBe(
      '/relaycast-gateway-files/ws_1/file_2/q%26a%20report%231%3Fdraft.csv',
    );
    // No part of the filename leaked into the query string as a stray param.
    expect(url.searchParams.has('draft.csv')).toBe(false);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
