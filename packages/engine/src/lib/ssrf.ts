export interface SafeUrlOptions {
  /**
   * Reject loopback / link-local / private (RFC-1918, unique-local) hosts.
   *
   * Default `false` (permissive): the engine's primary consumer is single-tenant
   * self-host, where the operator legitimately points A2A at LAN/localhost
   * agents — so only the scheme is enforced. A multi-tenant hosted deployment
   * should pass `strict: true` so an untrusted tenant can't aim the server at
   * internal infrastructure (e.g. `169.254.169.254` cloud metadata).
   */
  strict?: boolean;
}

/**
 * Guard for outbound fetches to operator/tenant-supplied URLs (A2A external
 * agent URLs, agent-card URLs). Always rejects non-http(s) schemes; in `strict`
 * mode additionally rejects loopback/link-local/private hosts.
 *
 * The strict host check is literal (no DNS resolution), so it does not defend
 * against DNS-rebinding; a hardened deployment should also validate the resolved
 * address at connect time.
 */
export function isSafeExternalUrl(rawUrl: string, options: SafeUrlOptions = {}): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  if (!options.strict) return true;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return false;
  }

  // IPv4 literal → check private/loopback/link-local ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // loopback
    if (a === 0) return false; // "this host"
    if (a === 169 && b === 254) return false; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a >= 224) return false; // multicast / reserved
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))) {
    return false;
  }

  return true;
}
