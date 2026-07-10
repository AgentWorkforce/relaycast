/**
 * Streaming SHA-256.
 *
 * Hardening item 2: the writeback ingest path needs to hash the body
 * while it streams to R2, never materializing the whole body. Web
 * Crypto's `crypto.subtle.digest` only accepts a single ArrayBuffer (no
 * incremental API on Workers), so we implement SHA-256 directly here.
 *
 * The implementation follows FIPS-180-4. It's bit-identical to
 * `crypto.subtle.digest("SHA-256", bytes)` — see the round-trip test in
 * `test/streaming-sha256.test.ts` which feeds the same bytes through both
 * and asserts equality.
 *
 * Usage:
 *   const hasher = new StreamingSha256();
 *   for await (const chunk of stream) hasher.update(chunk);
 *   const hex = hasher.digestHex();
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

export class StreamingSha256 {
  private h: Uint32Array;
  // 64-byte working buffer; once full, we hash it into `h` and reset.
  private buffer: Uint8Array = new Uint8Array(64);
  private bufferLen = 0;
  // Total bytes hashed so far (used for the length field at finalize).
  // Workers don't ship with BigInt-free DataView for 64-bit so we just
  // track a regular number — workspace writes never exceed 2^53 bytes.
  private totalLen = 0;
  private finalized: Uint8Array | null = null;

  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
  }

  update(chunk: Uint8Array): void {
    if (this.finalized) {
      throw new Error("StreamingSha256 cannot be updated after digest()");
    }
    let offset = 0;
    let remaining = chunk.byteLength;
    this.totalLen += remaining;

    if (this.bufferLen > 0) {
      const take = Math.min(64 - this.bufferLen, remaining);
      this.buffer.set(chunk.subarray(0, take), this.bufferLen);
      this.bufferLen += take;
      offset += take;
      remaining -= take;
      if (this.bufferLen === 64) {
        this.processBlock(this.buffer);
        this.bufferLen = 0;
      }
    }

    while (remaining >= 64) {
      this.processBlock(chunk.subarray(offset, offset + 64));
      offset += 64;
      remaining -= 64;
    }

    if (remaining > 0) {
      this.buffer.set(chunk.subarray(offset, offset + remaining), 0);
      this.bufferLen = remaining;
    }
  }

  digest(): Uint8Array {
    if (this.finalized) {
      return new Uint8Array(this.finalized);
    }
    // Append the FIPS padding: 0x80, zeros, then 64-bit big-endian length.
    const totalBits = this.totalLen * 8;
    const pad = new Uint8Array(this.bufferLen < 56 ? 64 : 128);
    pad.set(this.buffer.subarray(0, this.bufferLen), 0);
    pad[this.bufferLen] = 0x80;
    // Write the big-endian 64-bit length in the last 8 bytes. We split
    // across two 32-bit halves to dodge BigInt.
    const hi = Math.floor(totalBits / 2 ** 32);
    const lo = totalBits >>> 0;
    const lengthOffset = pad.byteLength - 8;
    const view = new DataView(pad.buffer);
    view.setUint32(lengthOffset, hi >>> 0, false);
    view.setUint32(lengthOffset + 4, lo, false);

    for (let i = 0; i < pad.byteLength; i += 64) {
      this.processBlock(pad.subarray(i, i + 64));
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) {
      outView.setUint32(i * 4, this.h[i], false);
    }
    this.finalized = new Uint8Array(out);
    return out;
  }

  digestHex(): string {
    const bytes = this.digest();
    let hex = "";
    for (let i = 0; i < bytes.byteLength; i += 1) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  private processBlock(block: Uint8Array): void {
    // Expand the 16 32-bit words of the block into a 64-word schedule.
    const w = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];
    let f = this.h[5];
    let g = this.h[6];
    let hh = this.h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + hh) >>> 0;
  }
}

/**
 * Stream a ReadableStream into R2 while computing SHA-256 incrementally.
 *
 * Tees the input: one branch is passed straight to `r2Put` (R2 handles
 * the streaming put natively), the other is consumed chunk-by-chunk by a
 * {@link StreamingSha256}. Returns the hex digest plus the total byte
 * count. The body is NEVER materialized as a single string or buffer in
 * the DO heap.
 */
export async function streamToR2WithHash(
  source: ReadableStream<Uint8Array>,
  r2Put: (stream: ReadableStream<Uint8Array>) => Promise<unknown>,
  options: { maxBytes?: number } = {},
): Promise<{ hashHex: string; byteLength: number }> {
  const hasher = new StreamingSha256();
  let byteLength = 0;

  const counted = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        byteLength += chunk.byteLength;
        if (
          typeof options.maxBytes === "number" &&
          byteLength > options.maxBytes
        ) {
          throw new StreamByteLimitError(byteLength, options.maxBytes);
        }
        hasher.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );

  await r2Put(counted);
  return { hashHex: hasher.digestHex(), byteLength };
}

export class StreamByteLimitError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`streamed body exceeded ${maxBytes} bytes`);
    this.name = "StreamByteLimitError";
  }
}
