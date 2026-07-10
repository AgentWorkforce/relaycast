export const DEFAULT_MAX_WRITE_BYTES = 10 * 1024 * 1024;

/**
 * Soft slack over the raw byte limit to account for JSON framing
 * (`{"content":"...","path":"/...","ifMatch":"rev_..."}` etc.) since
 * Content-Length is the on-wire body size, while the byte limit is meant
 * for the encoded payload itself. Conservative: enough overhead for
 * reasonable headers/metadata, well short of doubling the effective limit.
 */
export const WRITE_BODY_FRAMING_SLACK = 64 * 1024;

export type ContentLengthRejection = {
  status: number;
  code: string;
  message: string;
};

export class WriteBodyOverflowError extends Error {
  readonly consumed: number;
  readonly limit: number;

  constructor(consumed: number, limit: number) {
    super(
      `request body exceeded the limit of ${limit} bytes (read at least ${consumed})`,
    );
    this.name = "WriteBodyOverflowError";
    this.consumed = consumed;
    this.limit = limit;
  }
}

export function maxWriteBytesFromConfig(raw: string | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_WRITE_BYTES;
}

export function effectiveWriteLimitFromConfig(raw: string | undefined): number {
  return maxWriteBytesFromConfig(raw) + WRITE_BODY_FRAMING_SLACK;
}

export function rejectJsonWriteContentLength(
  request: Request,
  limit: number,
): ContentLengthRejection | null {
  const header = request.headers.get("Content-Length");
  if (header === null || header.trim() === "") {
    return {
      status: 411,
      code: "length_required",
      message: "Content-Length header is required for JSON write requests",
    };
  }
  const length = Number.parseInt(header, 10);
  if (!Number.isFinite(length) || length < 0) {
    return {
      status: 411,
      code: "length_required",
      message: "Content-Length header must be a non-negative integer",
    };
  }
  if (length > limit) {
    return {
      status: 413,
      code: "payload_too_large",
      message: `request body of ${length} bytes exceeds the limit of ${limit} bytes`,
    };
  }
  return null;
}

export async function readJsonWithLimit<T>(
  request: Request,
  limit: number,
  readJsonFallback: (request: Request) => Promise<T> = async (
    fallbackRequest,
  ) => JSON.parse(await fallbackRequest.text()) as T,
): Promise<T> {
  const body = request.body;
  if (!body) {
    return readJsonFallback(request);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let consumed = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      if (!value) continue;
      consumed += value.byteLength;
      if (consumed > limit) {
        try {
          await reader.cancel("write body exceeds size limit");
        } catch {
          /* best effort */
        }
        throw new WriteBodyOverflowError(consumed, limit);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  return JSON.parse(text) as T;
}
