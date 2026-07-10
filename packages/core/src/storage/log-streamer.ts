import type { ScopedS3Client } from "./client.js";

const PART_SIZE = 5 * 1024 * 1024; // 5 MB — S3 minimum part size
const FLUSH_INTERVAL_MS = 30_000;

export class LogStreamer {
  private readonly s3: ScopedS3Client;
  private readonly key: string;
  private buffer = Buffer.alloc(0);
  private uploadId: string | null = null;
  private parts: Array<{ PartNumber: number; ETag: string }> = [];
  private partNumber = 1;
  private started = false;
  private closed = false;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private totalBytes = 0;

  constructor(s3: ScopedS3Client, sandboxId: string) {
    this.s3 = s3;
    this.key = `${sandboxId}/agent.log`;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("LogStreamer already started");
    }
    if (this.closed) {
      throw new Error("LogStreamer already finished");
    }

    this.started = true;

    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async write(chunk: Buffer | string): Promise<void> {
    if (!this.started || this.closed) {
      throw new Error("LogStreamer not active");
    }

    const payload = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.totalBytes += payload.length;
    this.buffer = Buffer.concat([this.buffer, payload]);

    await this.flush(true);
  }

  async finish(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopTimer();

    if (this.totalBytes === 0) {
      await this.abortMultipartIfStarted();
      // Write a minimal log entry so the file exists in S3 for status checks
      await this.s3.putObject(this.key, Buffer.from("[no output captured]\n"), "text/plain");
      return;
    }

    if (this.totalBytes < PART_SIZE) {
      await this.abortMultipartIfStarted();
      await this.s3.putObject(this.key, this.buffer, "text/plain");
      return;
    }

    await this.flush(true);

    if (this.buffer.length > 0) {
      await this.uploadPart(this.buffer);
      this.buffer = Buffer.alloc(0);
    }

    if (!this.uploadId) {
      throw new Error("Multipart upload not initialized");
    }

    await this.s3.completeMultipartUpload(this.key, this.uploadId, this.parts);
    this.uploadId = null;
    this.parts = [];
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopTimer();
    await this.abortMultipartIfStarted();
    this.buffer = Buffer.alloc(0);
    this.totalBytes = 0;
    this.parts = [];
    this.partNumber = 1;
  }

  private async flush(force = false): Promise<void> {
    if (!this.started || this.flushing || this.buffer.length < PART_SIZE) {
      return;
    }
    if (this.closed && !force) {
      return;
    }

    this.flushing = true;
    try {
      while (this.buffer.length >= PART_SIZE) {
        const nextPart = Buffer.from(this.buffer.subarray(0, PART_SIZE));
        this.buffer = Buffer.from(this.buffer.subarray(PART_SIZE));
        await this.uploadPart(nextPart);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async ensureMultipartUpload(): Promise<void> {
    if (!this.uploadId) {
      this.uploadId = await this.s3.createMultipartUpload(this.key, "text/plain");
    }
  }

  private async uploadPart(part: Buffer): Promise<void> {
    await this.ensureMultipartUpload();

    if (!this.uploadId) {
      throw new Error("Multipart upload not initialized");
    }

    const etag = await this.s3.uploadPart(
      this.key,
      this.uploadId,
      this.partNumber,
      part,
    );

    this.parts.push({ PartNumber: this.partNumber, ETag: etag });
    this.partNumber += 1;
  }

  private async abortMultipartIfStarted(): Promise<void> {
    if (!this.uploadId) {
      return;
    }

    await this.s3.abortMultipartUpload(this.key, this.uploadId);
    this.uploadId = null;
    this.parts = [];
    this.partNumber = 1;
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
