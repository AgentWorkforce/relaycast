export interface SafeUrlOptions {
  /** Reject hosts that are not globally routable. Default false for self-host compatibility. */
  strict?: boolean;
  /** Require TLS in addition to the normal http(s) scheme check. */
  requireHttps?: boolean;
}

export interface ResolvedAddress {
  address: string;
  family?: number;
}

export type HostAddressResolver = (hostname: string) => Promise<Array<string | ResolvedAddress>>;

function parseIpv4(host: string): number | null {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function v4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = parseIpv4(base);
  if (baseValue === null) return false;
  const shift = 32 - prefix;
  return (value >>> shift) === (baseValue >>> shift);
}

function parseIpv6(input: string): bigint | null {
  let host = input.toLowerCase();
  if (host.includes('%')) host = host.slice(0, host.indexOf('%'));

  const ipv4Tail = host.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    host = `${host.slice(0, -ipv4Tail.length)}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < (halves.length === 2 ? 1 : 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(`0x${group}`);
  return value;
}

function ipv6Base(value: string): bigint {
  const parsed = parseIpv6(value);
  if (parsed === null) throw new Error(`Invalid IPv6 CIDR base: ${value}`);
  return parsed;
}

function v6InCidr(value: bigint, base: string, prefix: number): boolean {
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (ipv6Base(base) >> shift);
}

function ipv4FromInteger(value: bigint): string {
  const embedded = Number(value & 0xffff_ffffn) >>> 0;
  return [
    embedded >>> 24,
    (embedded >>> 16) & 0xff,
    (embedded >>> 8) & 0xff,
    embedded & 0xff,
  ].join('.');
}

/** IANA special-purpose address filtering used both before and during connection. */
export function isGlobalIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== null) {
    // The two PCP/TURN anycast addresses are the globally reachable exceptions
    // inside 192.0.0.0/24.
    const protocolAssignmentException = normalized === '192.0.0.9' || normalized === '192.0.0.10';
    return !(
      v4InCidr(ipv4, '0.0.0.0', 8)
      || v4InCidr(ipv4, '10.0.0.0', 8)
      || v4InCidr(ipv4, '100.64.0.0', 10)
      || v4InCidr(ipv4, '127.0.0.0', 8)
      || v4InCidr(ipv4, '169.254.0.0', 16)
      || v4InCidr(ipv4, '172.16.0.0', 12)
      || (v4InCidr(ipv4, '192.0.0.0', 24) && !protocolAssignmentException)
      || v4InCidr(ipv4, '192.0.2.0', 24)
      || v4InCidr(ipv4, '192.88.99.0', 24)
      || v4InCidr(ipv4, '192.168.0.0', 16)
      || v4InCidr(ipv4, '198.18.0.0', 15)
      || v4InCidr(ipv4, '198.51.100.0', 24)
      || v4InCidr(ipv4, '203.0.113.0', 24)
      || v4InCidr(ipv4, '224.0.0.0', 4)
      || v4InCidr(ipv4, '240.0.0.0', 4)
    );
  }

  const ipv6 = parseIpv6(normalized);
  if (ipv6 === null) return false;

  // IPv4-mapped IPv6 must inherit the embedded address's classification.
  if (v6InCidr(ipv6, '::ffff:0:0', 96)) {
    return isGlobalIpAddress(ipv4FromInteger(ipv6));
  }

  // The well-known NAT64 prefix and 6to4 both embed an IPv4 destination.
  // Do not let either representation bypass the IPv4 special-range policy.
  if (v6InCidr(ipv6, '64:ff9b::', 96)) {
    return isGlobalIpAddress(ipv4FromInteger(ipv6));
  }
  if (v6InCidr(ipv6, '2002::', 16)) {
    return isGlobalIpAddress(ipv4FromInteger(ipv6 >> 80n));
  }

  // IANA global unicast allocation is 2000::/3. Known special-purpose
  // sub-ranges within it remain blocked below.
  return v6InCidr(ipv6, '2000::', 3) && !(
    v6InCidr(ipv6, '2001::', 23)
    || v6InCidr(ipv6, '2001:db8::', 32)
    || v6InCidr(ipv6, '3fff::', 20)
  );
}

function parsedSafeUrl(rawUrl: string, options: SafeUrlOptions): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (options.requireHttps) {
    if (url.protocol !== 'https:') return null;
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }

  if (!options.strict) return url;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
  ) {
    return null;
  }
  if (parseIpv4(host) !== null || parseIpv6(host) !== null) {
    return isGlobalIpAddress(host) ? url : null;
  }
  return url;
}

/** Fast syntax/literal-IP check. Use `resolveSafeExternalUrl` before connecting. */
export function isSafeExternalUrl(rawUrl: string, options: SafeUrlOptions = {}): boolean {
  return parsedSafeUrl(rawUrl, options) !== null;
}

/**
 * Resolve every address and reject the hostname if any answer is non-global.
 * A production HTTP connector must run this same classification inside its DNS
 * lookup callback and connect to that validated answer to close the rebinding gap.
 */
export async function resolveSafeExternalUrl(
  rawUrl: string,
  resolver: HostAddressResolver,
  options: SafeUrlOptions = {},
): Promise<URL | null> {
  const effectiveOptions = { strict: true, ...options };
  const url = parsedSafeUrl(rawUrl, effectiveOptions);
  if (!url) return null;
  if (!effectiveOptions.strict) return url;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (parseIpv4(host) !== null || parseIpv6(host) !== null) return url;
  let resolved: Array<string | ResolvedAddress>;
  try {
    resolved = await resolver(host);
  } catch {
    return null;
  }
  if (resolved.length === 0) return null;
  return resolved.every((entry) => isGlobalIpAddress(typeof entry === 'string' ? entry : entry.address))
    ? url
    : null;
}
