/**
 * Credential Store — S3-backed encrypted credential storage keyed by userId.
 *
 * S3 layout:
 *   {bucket}/{prefix}/{userId}/{provider}/credentials.json.enc
 *   {bucket}/{prefix}/{userId}/metadata.json
 *
 * Credentials are encrypted with AES-256-GCM before writing and decrypted
 * on read. The metadata file tracks which providers are authenticated.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  encryptCredentialAsync,
  decryptCredentialAsync,
  type EncryptedEnvelope,
} from "./credential-encryption.js";

export interface CredentialStoreConfig {
  bucket: string;
  prefix?: string;
  region?: string;
  encryptionKey: string;
  /**
   * Optional pre-built S3 client. The Cloudflare Worker has no IAM
   * identity, so it must inject a client backed by STS-broker temp creds
   * rather than letting CredentialStore build one against the default
   * credential chain (which would silently fall through to no creds and
   * 403 on the first PutObject). Lambda callers can omit this and let
   * the constructor build the standard region-default client.
   */
  client?: S3Client;
}

export interface CredentialMetadataEntry {
  authenticatedAt: string;
  provider: string;
}

export interface CredentialStoreMetadata {
  providers: Record<string, CredentialMetadataEntry>;
  lastUpdated: string;
}

export interface DaytonaCredential {
  provider: "daytona";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  orgId?: string;
}

export class CredentialStore {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private encryptionKey: string;

  constructor(config: CredentialStoreConfig) {
    if (!config.encryptionKey) {
      throw new Error("CredentialStore requires an encryptionKey");
    }

    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "credentials";
    this.encryptionKey = config.encryptionKey;

    this.client =
      config.client ??
      new S3Client({
        region:
          config.region ??
          process.env.AWS_REGION ??
          process.env.AWS_DEFAULT_REGION ??
          "us-east-1",
      });
  }

  /**
   * Store encrypted credentials for a user/provider.
   */
  async store(
    userId: string,
    provider: string,
    credentialJson: string
  ): Promise<void> {
    const envelope = await encryptCredentialAsync(credentialJson, this.encryptionKey);
    const key = this.credentialKey(userId, provider);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(envelope),
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      })
    );

    await this.updateMetadata(userId, provider);
  }

  /**
   * Retrieve and decrypt credentials for a user/provider.
   * Returns null if not found.
   */
  async retrieve(
    userId: string,
    provider: string
  ): Promise<string | null> {
    const key = this.credentialKey(userId, provider);

    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      );

      const body = response.Body;
      if (!body) return null;

      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      const envelope = JSON.parse(
        Buffer.concat(chunks).toString("utf-8")
      ) as EncryptedEnvelope;

      return decryptCredentialAsync(envelope, this.encryptionKey);
    } catch (err: unknown) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  /**
   * Check if credentials exist for a user/provider without downloading.
   */
  async exists(userId: string, provider: string): Promise<boolean> {
    const key = this.credentialKey(userId, provider);

    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return true;
    } catch (err: unknown) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /**
   * Delete encrypted credentials for a user/provider key.
   *
   * S3 DeleteObject is idempotent for absent objects. Retrieval is governed by
   * the object delete, while metadata cleanup keeps the provider listing from
   * advertising a credential that can no longer be read.
   */
  async delete(userId: string, provider: string): Promise<void> {
    const key = this.credentialKey(userId, provider);

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );

    await this.removeMetadataEntry(userId, provider);
  }

  /**
   * Get metadata listing all authenticated providers for a user.
   */
  async getMetadata(
    userId: string
  ): Promise<CredentialStoreMetadata | null> {
    const key = this.metadataKey(userId);

    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );

      const body = response.Body;
      if (!body) return null;

      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      return JSON.parse(
        Buffer.concat(chunks).toString("utf-8")
      ) as CredentialStoreMetadata;
    } catch (err: unknown) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private credentialKey(userId: string, provider: string): string {
    return `${this.prefix}/${userId}/${provider}/credentials.json.enc`;
  }

  private metadataKey(userId: string): string {
    return `${this.prefix}/${userId}/metadata.json`;
  }

  /**
   * Read-modify-write metadata for this user.
   * Note: not atomic — concurrent store() calls for the same user could
   * lose a provider entry. Auth sessions are sequential per user in
   * practice, so this is acceptable. If needed, move metadata to a DB
   * with conditional writes.
   */
  private async updateMetadata(
    userId: string,
    provider: string
  ): Promise<void> {
    const existing = await this.getMetadata(userId);
    const metadata: CredentialStoreMetadata = existing ?? {
      providers: {},
      lastUpdated: "",
    };

    metadata.providers[provider] = {
      authenticatedAt: new Date().toISOString(),
      provider,
    };
    metadata.lastUpdated = new Date().toISOString();

    const key = this.metadataKey(userId);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: "application/json",
      })
    );
  }

  private async removeMetadataEntry(
    userId: string,
    provider: string
  ): Promise<void> {
    const existing = await this.getMetadata(userId);
    if (!existing || !(provider in existing.providers)) {
      return;
    }

    delete existing.providers[provider];
    existing.lastUpdated = new Date().toISOString();

    const key = this.metadataKey(userId);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(existing, null, 2),
        ContentType: "application/json",
      })
    );
  }
}

/**
 * Returns a CredentialStore instance configured from env vars for
 * bucket/prefix and an explicit encryption key.
 */
export function createCredentialStore(
  encryptionKey: string
): CredentialStore {
  const bucket = process.env.CREDENTIAL_S3_BUCKET ?? process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "CREDENTIAL_S3_BUCKET (or S3_BUCKET) must be set for credential storage"
    );
  }

  const config: CredentialStoreConfig = {
    bucket,
    prefix: process.env.CREDENTIAL_S3_PREFIX ?? "credentials",
    encryptionKey,
  };

  return new CredentialStore(config);
}

function isNoSuchKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "NoSuchKey"
  );
}

function isNotFound(err: unknown): boolean {
  if (isNoSuchKey(err)) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "$metadata" in err &&
    (err as { $metadata: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 404
  );
}
