const CREDENTIAL_PATTERN = /\b(?:rk_live|at_live|nt_live|ot_live)_[A-Za-z0-9_-]+\b/g;
const CONNECT_INVITE_PATTERN =
  /https?:\/\/(?:www\.)?agentrelay\.com\/connect\/[A-Za-z0-9_-]+(?:\.json|\.md)?(?:\?[^\s]*)?/gi;

export function sanitizeConnectObserverText(text: string): string {
  return text
    .replace(CONNECT_INVITE_PATTERN, '[Relay Connect invite redacted]')
    .replace(CREDENTIAL_PATTERN, '[credential redacted]');
}

export function formatUtcTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  return `${date.toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', ' UTC')}`;
}
