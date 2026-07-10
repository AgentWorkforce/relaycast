import { createHash } from "node:crypto";

export function contentHash(bundle: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(bundle);
  return `sha256:${hash.digest("hex")}`;
}
