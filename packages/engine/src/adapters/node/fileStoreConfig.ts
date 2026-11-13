/**
 * `RELAYCAST_FILE_STORE` selection for the self-host server: `local` (the
 * default; bytes on disk under the file directory) or `s3` (bytes in a bucket,
 * so the pod needs no persistent volume for files). Credentials for S3 come
 * only from the AWS SDK's default chain (IRSA / EKS Pod Identity / instance
 * role); there is deliberately no static-key setting.
 */
import { ConfigError } from '../../bin/secretEnv.js';
import { DiskBlobStore, type FileBlobStore } from './files.js';
import { S3BlobStore } from './s3Blobs.js';

// A refused `RELAYCAST_FILE_*` setting is a ConfigError: the container
// entrypoint exits 64 on it like every other configuration refusal.

export type FileStoreConfig =
  | { kind: 'local'; dir: string }
  | { kind: 's3'; bucket: string; region: string; prefix: string; endpoint?: string; forcePathStyle: boolean };

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Parse the `RELAYCAST_FILE_*` settings; `defaultDir` is the local store's directory. */
export function loadFileStoreConfig(env: NodeJS.ProcessEnv, defaultDir: string): FileStoreConfig {
  const kind = read(env, 'RELAYCAST_FILE_STORE') ?? 'local';
  if (kind === 'local') {
    // Half-configured S3 must not silently keep files on a disk the pod may lose.
    const stray = Object.keys(env).filter((name) => name.startsWith('RELAYCAST_FILE_S3_') && read(env, name) !== undefined).sort();
    if (stray.length > 0) {
      throw new ConfigError(`${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} set but RELAYCAST_FILE_STORE is not s3; set RELAYCAST_FILE_STORE=s3 or unset ${stray.length === 1 ? 'it' : 'them'}`);
    }
    return { kind, dir: defaultDir };
  }
  if (kind !== 's3') throw new ConfigError(`RELAYCAST_FILE_STORE must be local or s3, got ${JSON.stringify(kind)}`);

  const bucket = read(env, 'RELAYCAST_FILE_S3_BUCKET');
  if (!bucket) throw new ConfigError('RELAYCAST_FILE_STORE=s3 requires RELAYCAST_FILE_S3_BUCKET');
  if (!BUCKET.test(bucket)) throw new ConfigError('RELAYCAST_FILE_S3_BUCKET is not a valid bucket name');
  const region = read(env, 'RELAYCAST_FILE_S3_REGION') ?? read(env, 'AWS_REGION');
  if (!region) throw new ConfigError('RELAYCAST_FILE_STORE=s3 requires RELAYCAST_FILE_S3_REGION (or AWS_REGION)');
  if (!REGION.test(region)) throw new ConfigError('RELAYCAST_FILE_S3_REGION is not a valid region');
  const prefix = (read(env, 'RELAYCAST_FILE_S3_PREFIX') ?? '').replace(/^\/+|\/+$/g, '');
  if (prefix.split('/').some((segment) => prefix !== '' && (segment === '' || segment === '.' || segment === '..'))) {
    throw new ConfigError('RELAYCAST_FILE_S3_PREFIX must not contain empty, "." or ".." segments');
  }
  const endpoint = read(env, 'RELAYCAST_FILE_S3_ENDPOINT');
  if (endpoint !== undefined) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new ConfigError('RELAYCAST_FILE_S3_ENDPOINT must be a URL'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError('RELAYCAST_FILE_S3_ENDPOINT must be http(s)');
  }
  const pathStyle = read(env, 'RELAYCAST_FILE_S3_FORCE_PATH_STYLE');
  if (pathStyle !== undefined && pathStyle !== 'true' && pathStyle !== 'false') {
    throw new ConfigError('RELAYCAST_FILE_S3_FORCE_PATH_STYLE must be true or false');
  }
  return { kind, bucket, region, prefix, ...(endpoint ? { endpoint } : {}), forcePathStyle: pathStyle === 'true' };
}

/** The blob store for a parsed config. */
export function createFileBlobStore(config: FileStoreConfig): FileBlobStore {
  return config.kind === 'local'
    ? new DiskBlobStore(config.dir)
    : new S3BlobStore(config);
}

/** Log-safe one-line summary (no credentials exist to leak). */
export function describeFileStoreConfig(config: FileStoreConfig): string {
  return config.kind === 'local'
    ? 'file store: local'
    : `file store: s3 bucket=${config.bucket} region=${config.region} prefix=${config.prefix || '(none)'}${config.endpoint ? ` endpoint=${config.endpoint}` : ''}`;
}
