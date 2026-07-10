import { redactBody, redactHeaders, shouldRecord } from "./redact.js";

const DEFAULT_SAMPLE_RATE = 100;
const MAX_BODY_BYTES = 256 * 1024;
const OVERSIZE_PREFIX = "[OVERSIZE:";
const textEncoder = new TextEncoder();

export interface RecorderEnv {
  TRAFFIC_RECORDER: R2Bucket;
  ROUTER_CONFIG: KVNamespace;
}

type RecorderContext = Pick<ExecutionContext, "waitUntil">;
type BodyReader = {
  body: ReadableStream<unknown> | null;
  bodyUsed: boolean;
  headers: Headers;
  text(): Promise<string>;
};

type TrafficRecord = {
  ts: string;
  method: string;
  path: string;
  query: string;
  request_headers: Record<string, string>;
  request_body: string | null;
  response_status: number;
  response_headers: Record<string, string>;
  response_body: string | null;
  request_id: string;
};

function normalizeSampleRate(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SAMPLE_RATE;
  }

  return Math.min(100, Math.max(0, parsed));
}

function makeOversizePlaceholder(size: number): string {
  return `${OVERSIZE_PREFIX}${size}]`;
}

async function readBody(
  payload: BodyReader | null,
  path: string,
  contentType: string | null,
): Promise<string | null> {
  if (!payload || payload.body == null || payload.bodyUsed) {
    return null;
  }

  const body = await payload.text();
  const redactedBody = redactBody(path, body, contentType);
  if (redactedBody == null) {
    return null;
  }

  const bodySize = textEncoder.encode(redactedBody).length;
  if (bodySize > MAX_BODY_BYTES) {
    return makeOversizePlaceholder(bodySize);
  }

  return redactedBody;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function buildRecordKey(timestamp: Date, requestId: string): string {
  const year = timestamp.getUTCFullYear();
  const month = padDatePart(timestamp.getUTCMonth() + 1);
  const day = padDatePart(timestamp.getUTCDate());
  const hour = padDatePart(timestamp.getUTCHours());
  return `corpus/${year}/${month}/${day}/${hour}/${requestId}.ndjson`;
}

function getRequestId(request: Request): string {
  return (
    request.headers.get("x-request-id") ??
    request.headers.get("cf-ray") ??
    request.headers.get("traceparent") ??
    crypto.randomUUID()
  );
}

export async function maybeRecord(
  request: Request,
  response: Response,
  env: RecorderEnv,
  ctx: RecorderContext,
): Promise<void> {
  try {
    const url = new URL(request.url);
    if (!shouldRecord(url.pathname)) {
      return;
    }

    const sampleRate = normalizeSampleRate(await env.ROUTER_CONFIG.get("RECORDER_SAMPLE_RATE"));
    if (Math.random() * 100 >= sampleRate) {
      return;
    }

    const requestClone = request.bodyUsed ? null : request.clone();
    const responseClone = response.bodyUsed ? null : response.clone();
    const timestamp = new Date();
    const requestId = getRequestId(request);

    const record: TrafficRecord = {
      ts: timestamp.toISOString(),
      method: request.method,
      path: url.pathname,
      query: url.search.startsWith("?") ? url.search.slice(1) : url.search,
      request_headers: redactHeaders(request.headers),
      request_body: await readBody(
        requestClone,
        url.pathname,
        requestClone?.headers.get("content-type") ?? null,
      ),
      response_status: response.status,
      response_headers: redactHeaders(response.headers),
      response_body: await readBody(
        responseClone,
        url.pathname,
        responseClone?.headers.get("content-type") ?? null,
      ),
      request_id: requestId,
    };

    const line = `${JSON.stringify(record)}\n`;
    const key = buildRecordKey(timestamp, requestId);
    ctx.waitUntil(env.TRAFFIC_RECORDER.put(key, line));
  } catch (error) {
    console.error("traffic recorder failed", error);
  }
}
