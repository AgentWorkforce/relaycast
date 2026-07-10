import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import type { S3Credentials } from "../auth/credentials.js";

type MultipartPart = {
  PartNumber: number;
  ETag: string;
};

export class ScopedS3Client {
  private client: S3Client | null;
  private bucket: string;
  private prefix: string;
  private backend: "s3" | "cloud-api";
  private cloudApiUrl: string;
  private cloudApiAccessToken: string;
  private cloudApiRefreshToken: string;
  private runId: string;

  constructor(credentials: S3Credentials) {
    this.bucket = credentials.bucket;
    this.prefix = credentials.prefix;
    this.backend = credentials.backend ?? (process.env.WORKFLOW_STORAGE_BACKEND === "cloud-api" ? "cloud-api" : "s3");
    this.cloudApiUrl = stripTrailingSlash(
      credentials.cloudApiUrl
        ?? process.env.WORKFLOW_STORAGE_CLOUD_API_URL
        ?? process.env.CLOUD_API_URL
        ?? "",
    );
    this.cloudApiAccessToken =
      credentials.cloudApiAccessToken
      ?? process.env.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN
      ?? process.env.CLOUD_API_ACCESS_TOKEN
      ?? credentials.sessionToken
      ?? "";
    this.cloudApiRefreshToken =
      credentials.cloudApiRefreshToken
      ?? process.env.CLOUD_API_REFRESH_TOKEN
      ?? "";
    this.runId = process.env.RUN_ID ?? credentials.prefix.split("/")[1] ?? "";

    this.client = this.backend === "s3"
      ? new S3Client({
          region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
          credentials: {
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
        })
      : null;
  }

  scopedKey(parts: string[]): string {
    return [this.prefix, ...parts].join("/");
  }

  private fullKey(key: string): string {
    return this.scopedKey([key]);
  }

  async putObject(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    if (this.backend === "cloud-api") {
      await this.fetchCloudObject(key, {
        method: "PUT",
        headers: contentType ? { "content-type": contentType } : undefined,
        body: body as unknown as BodyInit,
      });
      return;
    }

    await this.s3Client().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    if (this.backend === "cloud-api") {
      const response = await this.fetchCloudObject(key);
      return Buffer.from(await response.arrayBuffer());
    }

    const response = await this.s3Client().send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
      }),
    );

    const body = response.Body;
    if (!body) {
      throw new Error(`GetObject returned no body for key: ${this.fullKey(key)}`);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  /**
   * Get the size of an object in bytes. Returns null if the object doesn't exist.
   */
  async headObject(key: string): Promise<{ size: number } | null> {
    if (this.backend === "cloud-api") {
      const response = await this.fetchCloudObject(key, { method: "HEAD" }, [404]);
      if (response.status === 404) {
        return null;
      }
      return { size: Number.parseInt(response.headers.get("content-length") ?? "0", 10) || 0 };
    }

    try {
      const response = await this.s3Client().send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
        }),
      );
      return { size: response.ContentLength ?? 0 };
    } catch (err: unknown) {
      if (err && typeof err === "object" && "name" in err && err.name === "NotFound") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Read a byte range from an S3 object. Used for incremental log streaming.
   * Returns the content and the total object size.
   */
  async getObjectRange(key: string, startByte: number): Promise<{ content: Buffer; totalSize: number }> {
    if (this.backend === "cloud-api") {
      const head = await this.headObject(key);
      if (!head) {
        return { content: Buffer.alloc(0), totalSize: 0 };
      }
      const response = await this.fetchCloudObject(key, {
        headers: { range: `bytes=${startByte}-` },
      });
      return {
        content: Buffer.from(await response.arrayBuffer()),
        totalSize: head.size,
      };
    }

    const response = await this.s3Client().send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Range: `bytes=${startByte}-`,
      }),
    );

    const body = response.Body;
    if (!body) {
      return { content: Buffer.alloc(0), totalSize: 0 };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }

    // ContentRange: "bytes 0-999/5000"
    const totalSize = response.ContentRange
      ? parseInt(response.ContentRange.split("/")[1], 10)
      : response.ContentLength ?? 0;

    return { content: Buffer.concat(chunks), totalSize };
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    if (this.backend === "cloud-api") {
      const response = await this.fetchCloudObject(key, {
        method: "POST",
        headers: contentType ? { "content-type": contentType } : undefined,
      }, [], "uploads=1");
      const payload = await response.json() as { uploadId?: unknown };
      if (typeof payload.uploadId !== "string" || payload.uploadId.length === 0) {
        throw new Error(`Failed to create multipart upload for key: ${key}`);
      }
      return payload.uploadId;
    }

    const response = await this.s3Client().send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );

    if (!response.UploadId) {
      throw new Error(`Failed to create multipart upload for key: ${this.fullKey(key)}`);
    }

    return response.UploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string> {
    if (this.backend === "cloud-api") {
      const response = await this.fetchCloudObject(key, {
        method: "PUT",
        body: body as unknown as BodyInit,
      }, [], `uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`);
      const payload = await response.json() as { etag?: unknown };
      if (typeof payload.etag !== "string" || payload.etag.length === 0) {
        throw new Error(`Missing ETag for part ${partNumber} on key: ${key}`);
      }
      return payload.etag;
    }

    const response = await this.s3Client().send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
      }),
    );

    if (!response.ETag) {
      throw new Error(`Missing ETag for part ${partNumber} on key: ${this.fullKey(key)}`);
    }

    return response.ETag;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    if (this.backend === "cloud-api") {
      await this.fetchCloudObject(key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      }, [], `uploadId=${encodeURIComponent(uploadId)}`);
      return;
    }

    await this.s3Client().send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (this.backend === "cloud-api") {
      await this.fetchCloudObject(key, {
        method: "DELETE",
      }, [], `uploadId=${encodeURIComponent(uploadId)}`);
      return;
    }

    await this.s3Client().send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        UploadId: uploadId,
      }),
    );
  }

  private cloudObjectUrl(key: string, query?: string): string {
    if (!this.cloudApiUrl || !this.runId) {
      throw new Error("Cloud API workflow storage requires CLOUD_API_URL and RUN_ID");
    }
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const suffix = query ? `?${query}` : "";
    return `${this.cloudApiUrl}/api/v1/workflows/runs/${encodeURIComponent(this.runId)}/storage/${encodedKey}${suffix}`;
  }

  private s3Client(): S3Client {
    if (!this.client) {
      throw new Error("S3 client is unavailable for cloud-api workflow storage");
    }
    return this.client;
  }

  private async fetchCloudObject(
    key: string,
    init: RequestInit = {},
    allowedStatuses: number[] = [],
    query?: string,
  ): Promise<Response> {
    if (!this.cloudApiAccessToken) {
      throw new Error("Cloud API workflow storage requires an access token");
    }
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.cloudApiAccessToken}`);
    let response = await fetch(this.cloudObjectUrl(key, query), {
      ...init,
      headers,
    });
    if (response.status === 401 && await this.refreshCloudApiAccessToken()) {
      headers.set("authorization", `Bearer ${this.cloudApiAccessToken}`);
      response = await fetch(this.cloudObjectUrl(key, query), {
        ...init,
        headers,
      });
    }
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      const text = await response.text().catch(() => "");
      throw new Error(`Cloud API workflow storage ${init.method ?? "GET"} ${key} failed: ${response.status}${text ? ` ${text}` : ""}`);
    }
    return response;
  }

  private async refreshCloudApiAccessToken(): Promise<boolean> {
    if (!this.cloudApiUrl || !this.cloudApiRefreshToken) {
      return false;
    }
    const response = await fetch(`${this.cloudApiUrl}/api/v1/auth/token/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: this.cloudApiRefreshToken }),
    }).catch(() => null);
    if (!response?.ok) {
      return false;
    }
    const payload = await response.json().catch(() => null) as {
      accessToken?: unknown;
      refreshToken?: unknown;
    } | null;
    if (typeof payload?.accessToken !== "string" || payload.accessToken.length === 0) {
      return false;
    }
    this.cloudApiAccessToken = payload.accessToken;
    if (typeof payload.refreshToken === "string" && payload.refreshToken.length > 0) {
      this.cloudApiRefreshToken = payload.refreshToken;
    }
    return true;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
