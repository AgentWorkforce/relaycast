import { describe, expect, it } from "vitest";
import { isSafeExternalUrl } from "../ssrf.js";

/**
 * `isSafeExternalUrl` is the single SSRF guard applied before every outbound
 * fetch in the engine. Two modes:
 *   - non-strict (default): only the scheme is enforced (permissive self-host).
 *   - strict: additionally rejects loopback / link-local / private hosts.
 *
 * The strict host check is intentionally literal (no DNS resolution), so it
 * cannot defend against DNS rebinding — that is documented, expected behavior
 * and is deliberately NOT asserted against here.
 */

describe("isSafeExternalUrl — non-strict (default)", () => {
  it("rejects non-http(s) schemes", () => {
    const cases: string[] = [
      "ftp://example.com/resource",
      "file:///etc/passwd",
      "gopher://example.com:70/1",
      "javascript:alert(1)",
      "data:text/plain;base64,aGk=",
      "mailto:someone@example.com",
      "ws://example.com/socket",
      "chrome://settings",
    ];
    for (const url of cases) {
      expect(isSafeExternalUrl(url), url).toBe(false);
      // A rejected scheme stays rejected regardless of strictness.
      expect(isSafeExternalUrl(url, { strict: true }), url).toBe(false);
    }
  });

  it("rejects malformed / unparseable URLs", () => {
    const cases: string[] = [
      "",
      "   ",
      "not a url",
      "example.com", // no scheme → not an absolute URL
      "http://", // no host
      "://missing-scheme.com",
      "http://exa mple.com", // space in authority
      "ht!tp://example.com",
    ];
    for (const url of cases) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });

  it("accepts http/https including private, loopback and metadata hosts (permissive default)", () => {
    const cases: string[] = [
      "http://example.com",
      "https://example.com/path?q=1#frag",
      "http://localhost",
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://10.0.0.1",
      "http://192.168.1.1",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata — allowed by default
      "http://[::1]",
      "http://internal.service.internal",
    ];
    for (const url of cases) {
      expect(isSafeExternalUrl(url), url).toBe(true);
    }
  });

  it("normalizes uppercase http/https schemes to allowed", () => {
    expect(isSafeExternalUrl("HTTP://example.com")).toBe(true);
    expect(isSafeExternalUrl("HTTPS://Example.COM")).toBe(true);
  });
});

describe("isSafeExternalUrl — strict mode", () => {
  describe("named loopback / local suffix hosts (rejected)", () => {
    const blocked: string[] = [
      "http://localhost",
      "https://localhost:8443",
      "http://app.localhost", // *.localhost
      "http://foo.local", // *.local (mDNS)
      "http://printer.home.local",
      "http://svc.internal", // *.internal
      "http://db.corp.internal",
      "http://0.0.0.0",
      "http://[::]", // unspecified address
      "http://[::1]", // IPv6 loopback, bracketed
    ];
    for (const url of blocked) {
      it(`rejects ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(false);
      });
    }
  });

  describe("IPv4 private / reserved ranges (rejected)", () => {
    const blocked: string[] = [
      "http://10.0.0.1", // 10/8
      "http://10.255.255.255",
      "http://127.0.0.1", // loopback
      "http://127.1.2.3",
      "http://0.0.0.1", // 0.0.0.0/8 "this host"
      "http://169.254.169.254", // link-local incl. cloud metadata
      "http://169.254.0.1",
      "http://172.16.0.1", // 172.16/12 low boundary
      "http://172.31.255.255", // 172.16/12 high boundary
      "http://172.20.10.5",
      "http://192.168.0.1", // 192.168/16
      "http://192.168.255.255",
      "http://224.0.0.1", // multicast
      "http://239.255.255.250",
      "http://255.255.255.255", // reserved (>=224)
    ];
    for (const url of blocked) {
      it(`rejects ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(false);
      });
    }
  });

  describe("IPv4 boundary cases just outside the blocked ranges (allowed)", () => {
    const allowed: string[] = [
      "http://172.15.0.1", // one below 172.16/12
      "http://172.32.0.1", // one above 172.31 (172.16/12 upper edge)
      "http://169.253.0.1", // one below 169.254/16 link-local
      "http://169.255.0.1", // one above 169.254/16
      "http://11.0.0.1", // adjacent to 10/8 but public
      "http://9.9.9.9", // adjacent to 10/8 (below) but public
      "http://126.255.255.255", // one below 127/8 loopback
      "http://128.0.0.1", // one above 127/8
      "http://1.0.0.1", // adjacent to 0/8 but public
      "http://223.255.255.255", // one below 224 multicast threshold
      "http://8.8.8.8",
      "http://1.1.1.1",
      "http://192.167.0.1", // adjacent to 192.168 but public
      "http://192.169.0.1",
    ];
    for (const url of allowed) {
      it(`accepts ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(true);
      });
    }
  });

  describe("IPv6 unique-local (fc00::/7) and link-local (fe80::/10) (rejected)", () => {
    const blocked: string[] = [
      "http://[fc00::1]", // unique-local fc prefix
      "http://[fd00::1]", // unique-local fd prefix
      "http://[fdff:ffff::1]",
      "http://[fe80::1]", // link-local fe8
      "http://[fe90::1]", // fe9
      "http://[fea0::1]", // fea
      "http://[feb0::1]", // feb
    ];
    for (const url of blocked) {
      it(`rejects ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(false);
      });
    }
  });

  describe("public IPv6 outside the blocked prefixes (allowed)", () => {
    const allowed: string[] = [
      "http://[2001:4860:4860::8888]", // Google public DNS
      "http://[2606:4700:4700::1111]", // Cloudflare public DNS
    ];
    for (const url of allowed) {
      it(`accepts ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(true);
      });
    }
  });

  describe("KNOWN GAPS — non-globally-routable ranges the guard does NOT block today (allowed)", () => {
    // These addresses are NOT globally routable, so a hardened deployment would
    // ideally reject them in strict mode. The guard does not block them today,
    // and these tests PIN that current behavior so the gap is unmistakably
    // intentional-for-now, not an oversight. If the guard is later hardened to
    // cover these ranges, move the relevant entry into the corresponding
    // "rejected" block and flip the expectation to `false`.
    const allowed: string[] = [
      // KNOWN GAP: deprecated IPv6 site-local fec0::/10 (RFC 3879). The IPv6
      // check only matches link-local fe80::/10 via the fe8/fe9/fea/feb
      // prefixes, so fec0:: falls through and is allowed in strict mode.
      "http://[fec0::1]",
      // KNOWN GAP: CGNAT / shared address space 100.64.0.0/10 (RFC 6598). The
      // IPv4 range check has no case for the 100.64–100.127 second octet, so
      // this non-globally-routable address is allowed in strict mode.
      "http://100.64.0.1",
    ];
    for (const url of allowed) {
      it(`currently accepts ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(true);
      });
    }
  });

  describe("legitimate public hosts (allowed)", () => {
    const allowed: string[] = [
      "http://example.com",
      "https://agent.example.org/.well-known/agent-card.json",
      "https://sub.domain.example.com:9443/path",
    ];
    for (const url of allowed) {
      it(`accepts ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(true);
      });
    }
  });

  describe("alternate IPv4 literal encodings normalize before the range check (rejected)", () => {
    // The guard is only sound because WHATWG `new URL` canonicalizes these to
    // dotted-quad (all = 127.0.0.1) before the regex/range logic runs. Pin that
    // reliance so a refactor away from `new URL` normalization cannot silently
    // reopen this classic SSRF bypass class.
    const blocked: string[] = [
      "http://2130706433", // decimal integer form of 127.0.0.1
      "http://0x7f000001", // hex form of 127.0.0.1
      "http://017700000001", // octal form of 127.0.0.1
    ];
    for (const url of blocked) {
      it(`rejects ${url}`, () => {
        expect(isSafeExternalUrl(url, { strict: true })).toBe(false);
      });
    }
  });

  it("still rejects non-http(s) schemes in strict mode", () => {
    expect(isSafeExternalUrl("file:///etc/passwd", { strict: true })).toBe(false);
    expect(isSafeExternalUrl("ftp://example.com", { strict: true })).toBe(false);
  });

  it("matches host suffixes case-insensitively", () => {
    expect(isSafeExternalUrl("http://LOCALHOST", { strict: true })).toBe(false);
    expect(isSafeExternalUrl("http://App.LocalHost", { strict: true })).toBe(false);
    expect(isSafeExternalUrl("http://Svc.INTERNAL", { strict: true })).toBe(false);
  });
});

describe("isSafeExternalUrl — credentials and ports (documented behavior)", () => {
  it("evaluates the host, not the userinfo, when credentials are present", () => {
    // Credentials are ignored; only the resolved hostname is range-checked.
    expect(
      isSafeExternalUrl("http://user:pass@example.com", { strict: true }),
    ).toBe(true);
    expect(
      isSafeExternalUrl("http://user:pass@127.0.0.1", { strict: true }),
    ).toBe(false);
    // Userinfo that merely looks like a public host does not launder a private target.
    expect(
      isSafeExternalUrl("http://example.com@10.0.0.1", { strict: true }),
    ).toBe(false);
  });

  it("ignores the port when classifying the host", () => {
    expect(isSafeExternalUrl("http://example.com:8080", { strict: true })).toBe(
      true,
    );
    expect(isSafeExternalUrl("http://127.0.0.1:8080", { strict: true })).toBe(
      false,
    );
    expect(isSafeExternalUrl("http://localhost:3000", { strict: true })).toBe(
      false,
    );
    // Non-strict allows any port on any host.
    expect(isSafeExternalUrl("http://localhost:3000")).toBe(true);
  });
});
