// Validated: fast deploy path test (2026-06-06)
const TRUSTED_APP_ORIGIN_ENV_KEY = "NEXT_PUBLIC_APP_URL";

export function getConfiguredAppOrigin(): string {
  const rawValue = process.env[TRUSTED_APP_ORIGIN_ENV_KEY]?.trim();
  if (rawValue) {
    const url = new URL(rawValue);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error(`${TRUSTED_APP_ORIGIN_ENV_KEY} must use http or https`);
    }
    return url.origin;
  }

  throw new Error(
    `Trusted app origin is not configured. Set ${TRUSTED_APP_ORIGIN_ENV_KEY}.`,
  );
}
