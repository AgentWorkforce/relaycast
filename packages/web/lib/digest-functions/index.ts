import { bundleSource } from "./bundle";
import { contentHash } from "./hash";
import { DEFAULT_DIGEST_BYTE_LIMIT, enforceQuota } from "./quota";
import type { CompiledDigestFunction, DigestFunctionSource } from "./types";

export function compileDigestFunction(
  src: DigestFunctionSource,
  options: { byteLimit?: number } = {},
): CompiledDigestFunction {
  const byteLimit = options.byteLimit ?? DEFAULT_DIGEST_BYTE_LIMIT;
  const bundle = bundleSource(src, byteLimit);
  enforceQuota(bundle, byteLimit);
  return {
    bundle,
    contentHash: contentHash(bundle),
    bytes: bundle.byteLength,
    entrypoint: src.entrypoint,
    runtime: src.runtime,
  };
}

export { bundleSource } from "./bundle";
export { contentHash } from "./hash";
export { DEFAULT_DIGEST_BYTE_LIMIT, enforceQuota } from "./quota";
export {
  deployDigestFunction,
  disableDigestFunction,
  fetchRecentInvocationLogs,
  getDigestFunction,
  listDigestFunctions,
  parseDigestFunctionDeployRequest,
  DigestFunctionDeployError,
} from "./store";
export { InvalidSourceError, QuotaExceededError } from "./types";
export type {
  CompiledDigestFunction,
  DigestFunctionSource,
  DigestRuntime,
  DigestSourceFile,
} from "./types";
