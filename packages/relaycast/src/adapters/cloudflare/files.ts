import { AwsClient } from 'aws4fetch';
import type { FileStorage } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';

const EXPIRES_IN_SECONDS = 3600;

/**
 * R2 (S3-compatible) implementation of the file storage port. R2 exposes an
 * S3 API at `<account>.r2.cloudflarestorage.com`; we hand the engine
 * short-lived presigned PUT/GET URLs.
 *
 * Presigning uses `aws4fetch` (a ~5KB Workers-native SigV4 signer) rather than
 * `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`. The AWS SDK v3 does
 * not bundle for the Workers runtime: its node `runtimeConfig` calls
 * `emitWarningIfUnsupportedVersion(process.version)`, which resolves to
 * `undefined` once esbuild mixes the node config with the browser
 * `@smithy/smithy-client` build — throwing `TypeError:
 * emitWarningIfUnsupportedVersion is not a function` on the first request and
 * 1101-ing every route. aws4fetch has no node-builtin dependency.
 */
export function createCloudflareFileStorage(env: CloudflareBindings): FileStorage {
  const bucket = env.FILES_BUCKET_NAME?.trim() || 'relaycast-files';
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const endpoint = `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  // SigV4 query-presign: aws4fetch's `signQuery` moves the signature into the
  // URL query string (vs. Authorization header), yielding a URL the engine can
  // hand to a client for a direct PUT/GET. `X-Amz-Expires` bounds its lifetime.
  const presign = async (
    method: 'PUT' | 'GET',
    storageKey: string,
  ): Promise<string> => {
    // Encode each path segment, not the whole key: `encodeURI` leaves `#`, `?`,
    // and `&` intact, so a user-supplied filename like `report#1.png` would be
    // parsed as a URL fragment/query and sign/store the wrong R2 object key.
    // `encodeURIComponent` per segment escapes those while preserving the `/`
    // separators in `<workspaceId>/<id>/<filename>`.
    const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/');
    const url = new URL(`${endpoint}/${bucket}/${encodedKey}`);
    url.searchParams.set('X-Amz-Expires', String(EXPIRES_IN_SECONDS));
    const signed = await client.sign(url.toString(), {
      method,
      aws: { signQuery: true },
    });
    return signed.url;
  };

  return {
    async createUploadUrl({ storageKey }) {
      const uploadUrl = await presign('PUT', storageKey);
      return {
        uploadUrl,
        expiresAt: new Date(Date.now() + EXPIRES_IN_SECONDS * 1000).toISOString(),
      };
    },
    async createDownloadUrl({ storageKey }) {
      return presign('GET', storageKey);
    },
  };
}
