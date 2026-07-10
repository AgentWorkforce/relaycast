import {
  buildSigningString,
  REQUEST_SIGNATURE_HEADER,
  REQUEST_TIMESTAMP_HEADER,
} from "@cloud/sts-broker/hmac.js";

const RETRY_DELAYS_MS = [500, 1000, 2000] as const;

export type SignedQueueBridgeConfig = {
  bridgeUrl: string;
  hmacSecret: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type BridgeErrorFactory = (message: string, status?: number) => Error;

async function signRequestBrowser(input: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp: string;
}): Promise<string> {
  const message = buildSigningString(input);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  const bytes = new Uint8Array(signatureBytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

export async function enqueueViaSignedQueueBridge(input: {
  path: string;
  body: string;
  config: SignedQueueBridgeConfig;
  errorPrefix: string;
  createError: BridgeErrorFactory;
}): Promise<void> {
  const { path, body, config, errorPrefix, createError } = input;
  if (!config.bridgeUrl || !config.hmacSecret) {
    throw createError(
      `${errorPrefix} QUEUE_BRIDGE_URL or QUEUE_BRIDGE_HMAC_SECRET missing on Worker`,
    );
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const timestamp = String(Math.floor((config.nowMs ?? Date.now)() / 1000));
    const signature = await signRequestBrowser({
      secret: config.hmacSecret,
      method: "POST",
      path,
      body,
      timestamp,
    });

    let response: Response;
    try {
      response = await fetchImpl(`${stripTrailingSlash(config.bridgeUrl)}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [REQUEST_SIGNATURE_HEADER]: signature,
          [REQUEST_TIMESTAMP_HEADER]: timestamp,
        },
        body,
      });
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw createError(
        `${errorPrefix} network error reaching queue bridge after ${attempt + 1} attempts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (response.ok) {
      return;
    }

    if (!isRetriableStatus(response.status)) {
      const text = await response.text().catch(() => "");
      throw createError(
        `${errorPrefix} queue bridge rejected request: ${response.status} ${text}`,
        response.status,
      );
    }

    lastError = createError(
      `${errorPrefix} queue bridge returned ${response.status}`,
      response.status,
    );
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : createError(`${errorPrefix} queue bridge call failed: ${String(lastError)}`);
}
