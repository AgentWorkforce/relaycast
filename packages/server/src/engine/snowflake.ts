const EPOCH_MS = Date.UTC(2020, 0, 1); // 2020-01-01T00:00:00.000Z

const WORKER_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;
const SEQUENCE_MASK = (1n << SEQUENCE_BITS) - 1n; // 0..4095
const WORKER_ID_MASK = (1n << WORKER_ID_BITS) - 1n; // 0..1023
const WORKER_ID_SHIFT = SEQUENCE_BITS;
const TIMESTAMP_SHIFT = SEQUENCE_BITS + WORKER_ID_BITS;

function fnv1a10Bits(input: string): number {
  // Fast, stable hash -> 10 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x3ff;
}

export class SnowflakeGenerator {
  private workerId?: number;
  private lastTimestamp = -1;
  private sequence = 0;

  constructor(workerId?: number) {
    this.workerId = workerId;
  }

  getWorkerId(): number {
    if (typeof this.workerId === 'number') {
      return this.workerId & 0x3ff;
    }
    const mid = process.env.FLY_MACHINE_ID;
    if (mid && mid.length > 0) {
      return fnv1a10Bits(mid);
    }
    return 0;
  }

  generate(): string {
    const wid = this.getWorkerId();
    let now = Date.now();
    if (now < this.lastTimestamp) {
      // Clamp to ensure monotonicity even if the system clock moves backwards.
      now = this.lastTimestamp;
    }

    if (now === this.lastTimestamp) {
      this.sequence = (this.sequence + 1) & Number(SEQUENCE_MASK);
      if (this.sequence === 0) {
        // Sequence overflow: wait for the next millisecond.
        while (now <= this.lastTimestamp) now = Date.now();
      }
    } else {
      this.sequence = 0;
    }

    this.lastTimestamp = now;

    const ts = BigInt(now - EPOCH_MS);
    const id =
      (ts << TIMESTAMP_SHIFT) |
      ((BigInt(wid) & WORKER_ID_MASK) << WORKER_ID_SHIFT) |
      (BigInt(this.sequence) & SEQUENCE_MASK);

    return id.toString();
  }

  static extractTimestamp(id: string): number {
    const n = BigInt(id);
    const ts = n >> TIMESTAMP_SHIFT;
    return Number(ts) + EPOCH_MS;
  }

  static extractWorkerId(id: string): number {
    const n = BigInt(id);
    const wid = (n >> WORKER_ID_SHIFT) & WORKER_ID_MASK;
    return Number(wid);
  }

  static extractSequence(id: string): number {
    const n = BigInt(id);
    const seq = n & SEQUENCE_MASK;
    return Number(seq);
  }
}

let defaultGenerator: SnowflakeGenerator | null = null;

export function generateId(): string {
  if (!defaultGenerator) defaultGenerator = new SnowflakeGenerator();
  return defaultGenerator.generate();
}

