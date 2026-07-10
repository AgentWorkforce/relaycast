export type DigestRuntime = "node20";

export interface DigestSourceFile {
  path: string;
  contents: string;
}

export interface DigestFunctionSource {
  files: DigestSourceFile[];
  entrypoint: string;
  runtime: DigestRuntime;
}

export interface CompiledDigestFunction {
  bundle: Uint8Array;
  contentHash: string;
  bytes: number;
  entrypoint: string;
  runtime: DigestRuntime;
}

export class InvalidSourceError extends Error {
  readonly code = "DIGEST_INVALID_SOURCE";
  constructor(message: string) {
    super(message);
    this.name = "InvalidSourceError";
  }
}

export class QuotaExceededError extends Error {
  readonly code = "DIGEST_QUOTA_EXCEEDED";
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`Digest bundle of ${bytes} bytes exceeds limit of ${limit} bytes`);
    this.name = "QuotaExceededError";
    this.bytes = bytes;
    this.limit = limit;
  }
}
