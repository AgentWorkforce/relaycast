// Source-of-truth version for the cloud-hosted relaycast gateway worker.
// Surfaced at `/health` via the engine's `appSemver` config (see
// adapters/cloudflare/index.ts). A deploy-time `APP_SEMVER` env still wins;
// this is the checked-in default so `/health` reports a real version instead
// of the engine's `0.1.0` fallback. Bumped to 1.0.0 for the gateway cutover.
export const SERVER_VERSION = '1.0.0' as const;
