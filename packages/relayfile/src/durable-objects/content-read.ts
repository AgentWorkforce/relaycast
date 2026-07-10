export type ContentReadHttpError = {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export async function streamR2ObjectContent(
  object: R2ObjectBody,
  encoding: "utf-8" | "base64",
  maxBytes: number,
  contentRef: string,
): Promise<string> {
  const objectSize = Number(
    (object as R2ObjectBody & { size?: number }).size ?? NaN,
  );
  if (Number.isFinite(objectSize) && objectSize > maxBytes) {
    throw contentTooLarge(contentRef, objectSize, maxBytes);
  }
  if (!object.body) {
    throw new Error(`content stream missing from R2 object: ${contentRef}`);
  }
  return encoding === "base64"
    ? streamToBase64WithLimit(object.body, maxBytes, contentRef)
    : streamToTextWithLimit(object.body, maxBytes, contentRef);
}

async function streamToTextWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  contentRef: string,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytesRead = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await cancelReader(reader, "relayfile content read exceeds byte limit");
        throw contentTooLarge(contentRef, bytesRead, maxBytes);
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
  return text;
}

async function streamToBase64WithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  contentRef: string,
): Promise<string> {
  const reader = stream.getReader();
  let bytesRead = 0;
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let encoded = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (carry.byteLength > 0) {
          encoded += bytesToBase64(carry);
        }
        break;
      }
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await cancelReader(reader, "relayfile content read exceeds byte limit");
        throw contentTooLarge(contentRef, bytesRead, maxBytes);
      }
      const bytes = carry.byteLength > 0 ? concatBytes(carry, value) : value;
      const encodableLength = bytes.byteLength - (bytes.byteLength % 3);
      if (encodableLength > 0) {
        encoded += bytesToBase64(bytes.subarray(0, encodableLength));
      }
      carry = copyBytes(bytes.subarray(encodableLength));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return encoded;
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    /* best effort */
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const combined = new Uint8Array(a.byteLength + b.byteLength);
  combined.set(a, 0);
  combined.set(b, a.byteLength);
  return combined;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function contentTooLarge(
  contentRef: string,
  byteLength: number,
  maxBytes: number,
): ContentReadHttpError {
  return {
    status: 413,
    code: "payload_too_large",
    message: `content ${contentRef} is ${byteLength} bytes, which exceeds the read limit of ${maxBytes} bytes`,
    details: { contentRef, byteLength, maxBytes },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Build bounded chunks so large content never creates O(n^2) strings.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}
