import { describe, expect, it } from 'vitest';
import { createFileBlobStore, describeFileStoreConfig, loadFileStoreConfig } from '../fileStoreConfig.js';
import { DiskBlobStore } from '../files.js';
import { S3BlobStore } from '../s3Blobs.js';

describe('RELAYCAST_FILE_STORE', () => {
  it('defaults to the local disk store', () => {
    const config = loadFileStoreConfig({}, '/data/relaycast-files');
    expect(config).toEqual({ kind: 'local', dir: '/data/relaycast-files' });
    expect(createFileBlobStore(config)).toBeInstanceOf(DiskBlobStore);
  });

  it('builds an S3 store from bucket, region and optional prefix/endpoint', () => {
    const config = loadFileStoreConfig({
      RELAYCAST_FILE_STORE: 's3',
      RELAYCAST_FILE_S3_BUCKET: 'acme-relaycast-files',
      RELAYCAST_FILE_S3_REGION: 'us-west-2',
      RELAYCAST_FILE_S3_PREFIX: '/relaycast/files/',
    }, '/unused');
    expect(config).toEqual({ kind: 's3', bucket: 'acme-relaycast-files', region: 'us-west-2', prefix: 'relaycast/files', forcePathStyle: false });
    const store = createFileBlobStore(config) as S3BlobStore;
    expect(store).toBeInstanceOf(S3BlobStore);
    expect(store.prefix).toBe('relaycast/files');
    expect(describeFileStoreConfig(config)).toBe('file store: s3 bucket=acme-relaycast-files region=us-west-2 prefix=relaycast/files');
    // AWS_REGION is accepted when the store's own region is unset (IRSA pods set it).
    expect(loadFileStoreConfig({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'b-ok', AWS_REGION: 'eu-central-1' }, '/x'))
      .toMatchObject({ region: 'eu-central-1' });
  });

  it('refuses incomplete or invalid settings as configuration errors', () => {
    const refuse = (env: NodeJS.ProcessEnv, message: RegExp) => {
      let error: unknown;
      try { loadFileStoreConfig(env, '/x'); } catch (e) { error = e; }
      expect((error as Error)?.name).toBe('ConfigError');
      expect((error as Error).message).toMatch(message);
    };
    refuse({ RELAYCAST_FILE_STORE: 'gcs' }, /must be local or s3/);
    // Half-configured S3 never silently falls back to disk.
    refuse({ RELAYCAST_FILE_S3_BUCKET: 'ok-bucket' }, /RELAYCAST_FILE_S3_BUCKET is set but RELAYCAST_FILE_STORE is not s3/);
    refuse({ RELAYCAST_FILE_STORE: 'local', RELAYCAST_FILE_S3_BUCKET: 'ok-bucket', RELAYCAST_FILE_S3_REGION: 'us-east-1' }, /are set but RELAYCAST_FILE_STORE is not s3/);
    refuse({ RELAYCAST_FILE_STORE: 's3' }, /requires RELAYCAST_FILE_S3_BUCKET/);
    refuse({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'Bad_Bucket' }, /not a valid bucket/);
    refuse({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'ok-bucket' }, /requires RELAYCAST_FILE_S3_REGION/);
    refuse({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'ok-bucket', RELAYCAST_FILE_S3_REGION: 'west' }, /not a valid region/);
    refuse({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'ok-bucket', RELAYCAST_FILE_S3_REGION: 'us-east-1', RELAYCAST_FILE_S3_PREFIX: 'a/../b' }, /PREFIX/);
    refuse({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'ok-bucket', RELAYCAST_FILE_S3_REGION: 'us-east-1', RELAYCAST_FILE_S3_ENDPOINT: 'not a url' }, /ENDPOINT/);
    refuse({ RELAYCAST_FILE_STORE: 's3', RELAYCAST_FILE_S3_BUCKET: 'ok-bucket', RELAYCAST_FILE_S3_REGION: 'us-east-1', RELAYCAST_FILE_S3_FORCE_PATH_STYLE: 'yes' }, /FORCE_PATH_STYLE/);
  });
});
