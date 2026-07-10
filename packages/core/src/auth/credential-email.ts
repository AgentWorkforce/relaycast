/**
 * Credential Email — Parse the provider-account email from stored
 * credential JSON, for display on the Cloud agents credential cards.
 *
 * Tries multiple strategies in order (mirrors credential-expiry.ts):
 * 1. claudeAiOauth nested format / .claude.json oauthAccount block
 * 2. Explicit email-ish fields at the top level or under account/tokens
 * 3. JWT id_token / access_token `email` claim (codex/ChatGPT format)
 *
 * Display-only: JWTs are decoded, never verified — do not use the result
 * for authorization decisions.
 */

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '==='.slice((payload.length + 3) & 3);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const EMAIL_FIELDS = ['emailAddress', 'email_address', 'email', 'accountEmail', 'account_email'];

function looksLikeEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function emailFromRecord(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  for (const field of EMAIL_FIELDS) {
    const value = (record as Record<string, unknown>)[field];
    if (looksLikeEmail(value)) return value.trim();
  }
  return null;
}

/**
 * Parse the provider-account email from a stored credential JSON string.
 * Returns null when no email can be determined (e.g. plain API keys).
 */
export function parseCredentialEmail(credentialJson: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(credentialJson) as Record<string, unknown>;
  } catch {
    return null;
  }

  // ── Strategy 1: nested account blocks ────────────────────────────────────
  // claude: { claudeAiOauth: {...} } and .claude.json: { oauthAccount: {...} }
  for (const key of ['claudeAiOauth', 'oauthAccount', 'account']) {
    const email = emailFromRecord(parsed[key]);
    if (email) return email;
  }

  // ── Strategy 1b: xai (Grok CLI) scope-keyed format ───────────────────────
  // ~/.grok/auth.json: { "https://auth.x.ai::<client_id>": { email, ... } }
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.includes('::')) continue;
    const email = emailFromRecord(value);
    if (email) return email;
  }

  // ── Strategy 2: explicit top-level fields ────────────────────────────────
  const topLevel = emailFromRecord(parsed);
  if (topLevel) return topLevel;

  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  const inTokens = emailFromRecord(tokens);
  if (inTokens) return inTokens;

  // ── Strategy 3: JWT claims (codex/ChatGPT id_token carries email) ────────
  const jwtCandidates: unknown[] = [
    tokens?.id_token,
    tokens?.access_token,
    parsed.id_token,
    parsed.access_token,
  ];
  for (const candidate of jwtCandidates) {
    if (typeof candidate !== 'string') continue;
    const claims = decodeJwtPayload(candidate);
    const email = emailFromRecord(claims);
    if (email) return email;
    // codex access tokens nest profile claims under the auth namespace
    const namespaced = claims?.['https://api.openai.com/profile'];
    const nsEmail = emailFromRecord(namespaced);
    if (nsEmail) return nsEmail;
  }

  return null;
}
