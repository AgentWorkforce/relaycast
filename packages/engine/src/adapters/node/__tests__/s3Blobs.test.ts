import { describe, expect, it, vi } from 'vitest';
import { S3BlobStore } from '../s3Blobs.js';

vi.mock('@aws-sdk/client-s3', () => { throw new Error("Cannot find package '@aws-sdk/client-s3'"); });

describe('S3BlobStore without the SDK', () => {
  it('fails verifyAccess (and so startup) with a ConfigError naming the package', async () => {
    const store = new S3BlobStore({ bucket: 'some-bucket', region: 'us-east-1' });
    const error = await store.verifyAccess().then(() => undefined, (e: unknown) => e);
    expect((error as Error)?.name).toBe('ConfigError');
    expect((error as Error).message).toMatch(/needs the @aws-sdk\/client-s3 package/);
  });
});
