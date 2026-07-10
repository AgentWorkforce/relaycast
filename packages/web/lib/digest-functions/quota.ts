import { QuotaExceededError } from "./types";

export const DEFAULT_DIGEST_BYTE_LIMIT = 256 * 1024;

export function enforceQuota(
  bundle: Uint8Array,
  limit: number = DEFAULT_DIGEST_BYTE_LIMIT,
): void {
  if (bundle.byteLength > limit) {
    throw new QuotaExceededError(bundle.byteLength, limit);
  }
}
