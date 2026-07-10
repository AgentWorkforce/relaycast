/**
 * Credential Expiry — Parse expiry dates from stored credential JSON.
 *
 * Tries multiple strategies in order:
 * 1. Decode JWT from access_token / tokens.access_token and extract exp
 * 2. Look for explicit expiry fields (expiresAt, expires_at, expiry, expiration)
 * 3. Use last_refresh + default TTL (8 days, conservative for ~10-day tokens)
 */

const DEFAULT_TTL_DAYS = 8;

/**
 * Attempt to decode a JWT and extract the `exp` claim as a Date.
 * Returns null if the string is not a valid JWT or has no exp.
 */
function decodeJwtExp(token: string): Date | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Base64url → base64 → decode
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '==='.slice((payload.length + 3) & 3);
    const decoded = JSON.parse(
      Buffer.from(padded, 'base64').toString('utf-8')
    ) as Record<string, unknown>;

    if (typeof decoded.exp === 'number') {
      return new Date(decoded.exp * 1000);
    }
  } catch {
    // Not a valid JWT or not valid JSON
  }
  return null;
}

/**
 * Parse a value that may be an ISO string, a Unix timestamp (number or
 * numeric string), or already a Date. Returns null if unparseable.
 */
function parseFlexibleDate(value: unknown): Date | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  if (typeof value === 'number') {
    // Distinguish seconds (Unix) vs milliseconds by magnitude
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  if (typeof value === 'string') {
    // Try Unix timestamp as string first
    const n = Number(value);
    if (!isNaN(n) && value.trim() !== '') {
      return parseFlexibleDate(n);
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Parse the expiry date from a stored credential JSON string.
 *
 * @param credentialJson - The raw (decrypted) credential JSON string.
 * @returns The expiry Date, or null if it cannot be determined.
 */
export function parseCredentialExpiry(credentialJson: string): Date | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(credentialJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  // ── Strategy 0a: xai (Grok CLI) scope-keyed format ────────────────────────
  // ~/.grok/auth.json: { "https://auth.x.ai::<client_id>": { key,
  // refresh_token, expires_at: "<ISO>", ... } }. Scope keys contain "::",
  // which no other credential shape uses at the top level.

  for (const [key, value] of Object.entries(parsed)) {
    if (!key.includes('::') || !value || typeof value !== 'object') continue;
    const scoped = value as Record<string, unknown>;
    if (typeof scoped.expires_at === 'string' || typeof scoped.expires_at === 'number') {
      const d = parseFlexibleDate(scoped.expires_at);
      if (d) return d;
    }
  }

  // ── Strategy 0: claudeAiOauth nested format ───────────────────────────────

  const claudeOauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
  if (claudeOauth && typeof claudeOauth === 'object') {
    if (typeof claudeOauth.expiresAt === 'number') {
      const d = new Date(claudeOauth.expiresAt);
      if (!isNaN(d.getTime())) return d;
    }

    if (typeof claudeOauth.accessToken === 'string') {
      const exp = decodeJwtExp(claudeOauth.accessToken);
      if (exp) return exp;
    }
  }

  // ── Strategy 1: JWT access_token ──────────────────────────────────────────

  // tokens.access_token (codex format)
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  if (tokens && typeof tokens.access_token === 'string') {
    const exp = decodeJwtExp(tokens.access_token);
    if (exp) return exp;
  }

  // top-level access_token
  if (typeof parsed.access_token === 'string') {
    const exp = decodeJwtExp(parsed.access_token);
    if (exp) return exp;
  }

  // top-level token field
  if (typeof parsed.token === 'string') {
    const exp = decodeJwtExp(parsed.token);
    if (exp) return exp;
  }

  // ── Strategy 2: Explicit expiry fields ────────────────────────────────────

  for (const field of ['expiresAt', 'expires_at', 'expiry', 'expiration']) {
    const val = parsed[field];
    if (val !== undefined && val !== null) {
      const d = parseFlexibleDate(val);
      if (d) return d;
    }
  }

  // Also check inside tokens object
  if (tokens) {
    for (const field of ['expiresAt', 'expires_at', 'expiry', 'expiration']) {
      const val = tokens[field];
      if (val !== undefined && val !== null) {
        const d = parseFlexibleDate(val);
        if (d) return d;
      }
    }
  }

  // ── Strategy 3: last_refresh + default TTL ────────────────────────────────

  if (typeof parsed.last_refresh === 'string' || typeof parsed.last_refresh === 'number') {
    const refreshDate = parseFlexibleDate(parsed.last_refresh);
    if (refreshDate) {
      return new Date(refreshDate.getTime() + DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}
