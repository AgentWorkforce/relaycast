import { Resource } from "sst";

/**
 * Resolve auth session secret from SST Resource, falling back to AUTH_SESSION_SECRET
 * only when running outside an SST-linked runtime.
 */
export function getAuthSessionSecret(): string {
  try {
    return Resource.AuthSessionSecret.value;
  } catch (error) {
    if (process.env.AUTH_SESSION_SECRET) {
      return process.env.AUTH_SESSION_SECRET;
    }
    throw error;
  }
}

/**
 * Resolve broker key secret — used to derive per-sandbox broker API keys
 * via HMAC. Separate from the auth session secret so a sandbox compromise
 * does not expose JWT signing material.
 */
export function getBrokerKeySecret(): string {
  return Resource.BrokerKeySecret.value;
}
