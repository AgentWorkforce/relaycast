import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../bin/secretEnv.js";
import {
  describePostgresConfig,
  loadPostgresConfig,
  parseDatabaseUrl,
  readCaFile,
} from "../config.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const CA_FILE = fixture("test-ca.pem");
const LEAF_FILE = fixture("test-leaf.pem");
// Dev-only fixture credentials, not secrets.
const PASSWORD = "pw-dev-only-123";
const URL_OK = `postgres://relaycast_runtime:${PASSWORD}@db.example.test:6543/app`;

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relaycast-pg-config-"));
  const path = join(dir, "file");
  writeFileSync(path, contents);
  return path;
}

function env(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    RELAYCAST_DATABASE_URL: URL_OK,
    RELAYCAST_DATABASE_CA_FILE: CA_FILE,
    ...overrides,
  };
}

/** Assert a ConfigError whose message never leaks the URL or password. */
function refuses(fn: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const text = (caught as Error).message;
  expect(text).toMatch(message);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toMatch(/:\/\/\S/);
  expect(text).not.toContain("@db.example.test");
}

describe("loadPostgresConfig", () => {
  it("builds a runtime config with defaults", () => {
    const config = loadPostgresConfig(env(), "runtime");
    expect(config).toMatchObject({
      mode: "runtime",
      host: "db.example.test",
      port: 6543,
      database: "app",
      user: "relaycast_runtime",
      password: PASSWORD,
      schema: "public",
      ownerRole: "relaycast_owner",
      runtimeRole: "relaycast_runtime",
      expectedRole: "relaycast_runtime",
      poolMax: undefined,
      statementTimeoutMs: undefined,
    });
    expect(config.caSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expects the owner role in owner mode, never the URL user", () => {
    const config = loadPostgresConfig(
      env({ RELAYCAST_DATABASE_OWNER_ROLE: "acme_owner" }),
      "owner",
    );
    expect(config.expectedRole).toBe("acme_owner");
    expect(config.user).toBe("relaycast_runtime");
  });

  it("reads the URL from RELAYCAST_DATABASE_URL_FILE", () => {
    const file = tmpFile(`${URL_OK}\n`);
    const config = loadPostgresConfig(
      env({
        RELAYCAST_DATABASE_URL: undefined,
        RELAYCAST_DATABASE_URL_FILE: file,
      }),
      "runtime",
    );
    expect(config.password).toBe(PASSWORD);
  });

  it("defaults the port and accepts sslmode=verify-full and postgresql://", () => {
    const config = loadPostgresConfig(
      env({
        RELAYCAST_DATABASE_URL: `postgresql://u:${PASSWORD}@db.example.test/app?sslmode=verify-full`,
      }),
      "runtime",
    );
    expect(config.port).toBe(5432);
  });

  it("parses pool and statement timeout settings", () => {
    const config = loadPostgresConfig(
      env({
        RELAYCAST_DATABASE_POOL_MAX: "7",
        RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS: "0",
      }),
      "runtime",
    );
    expect(config.poolMax).toBe(7);
    expect(config.statementTimeoutMs).toBe(0);
  });

  it("refuses a missing URL and a missing CA file", () => {
    refuses(
      () =>
        loadPostgresConfig(
          env({ RELAYCAST_DATABASE_URL: undefined }),
          "runtime",
        ),
      /RELAYCAST_DATABASE_URL .*required/,
    );
    refuses(
      () =>
        loadPostgresConfig(env({ RELAYCAST_DATABASE_CA_FILE: "" }), "runtime"),
      /RELAYCAST_DATABASE_CA_FILE \(or NODE_EXTRA_CA_CERTS\) is required/,
    );
  });

  it.each([["disable"], ["allow"], ["prefer"], ["require"], ["verify-ca"]])(
    "refuses sslmode=%s",
    (mode) => {
      refuses(
        () =>
          loadPostgresConfig(
            env({ RELAYCAST_DATABASE_URL: `${URL_OK}?sslmode=${mode}` }),
            "runtime",
          ),
        new RegExp(`sslmode=${mode}; only verify-full`),
      );
    },
  );

  it("refuses an unknown sslmode", () => {
    refuses(
      () => parseDatabaseUrl(`${URL_OK}?sslmode=bogus`),
      /unknown sslmode/,
    );
  });

  it.each([
    ["sslrootcert"],
    ["sslcert"],
    ["sslkey"],
    ["sslpassword"],
    ["sslcrl"],
  ])("refuses %s in the URL", (param) => {
    refuses(
      () => parseDatabaseUrl(`${URL_OK}?${param}=/tmp/x`),
      new RegExp(`sets ${param}; TLS material comes only from`),
    );
  });

  it("refuses ssl=false and unknown parameters", () => {
    refuses(() => parseDatabaseUrl(`${URL_OK}?ssl=false`), /sets ssl;/);
    refuses(
      () => parseDatabaseUrl(`${URL_OK}?options=-csearch_path%3Dpublic`),
      /unsupported parameter "options"/,
    );
  });

  it("refuses bad URLs without echoing them", () => {
    refuses(() => parseDatabaseUrl(`not a url ${PASSWORD}`), /not a valid URL/);
    refuses(
      () => parseDatabaseUrl(`mysql://u:${PASSWORD}@db.example.test/app`),
      /postgres:\/\/ or postgresql:\/\/ scheme/,
    );
    refuses(
      () => parseDatabaseUrl(`postgres://u:${PASSWORD}@db.example.test`),
      /must name a database/,
    );
    refuses(
      () => parseDatabaseUrl(`postgres://:${PASSWORD}@db.example.test/app`),
      /must include a user/,
    );
    refuses(
      () => parseDatabaseUrl(`postgres:///app?x=${PASSWORD}`),
      /TCP host/,
    );
  });

  it("refuses a URL without a password (no PGPASSWORD / .pgpass fallback)", () => {
    refuses(
      () =>
        parseDatabaseUrl("postgres://relaycast_runtime@db.example.test/app"),
      /must include a password/,
    );
  });

  it.each([
    ["PGREPLICATION"],
    ["PGBINARY"],
    ["PGCLIENT_ENCODING"],
    ["PGSSLNEGOTIATION"],
  ])("refuses %s, which node-postgres would apply", (name) => {
    refuses(
      () => loadPostgresConfig(env({ [name]: "database" }), "runtime"),
      new RegExp(`${name} must be unset`),
    );
  });

  it("accepts IPv6 literal hosts", () => {
    expect(
      parseDatabaseUrl(`postgres://u:${PASSWORD}@[::1]:5433/app`).host,
    ).toBe("::1");
  });

  it("refuses a schema other than public and malformed identifiers", () => {
    refuses(
      () =>
        loadPostgresConfig(
          env({ RELAYCAST_DATABASE_SCHEMA: "other" }),
          "runtime",
        ),
      /must be public/,
    );
    refuses(
      () =>
        loadPostgresConfig(
          env({ RELAYCAST_DATABASE_RUNTIME_ROLE: "Bad-Role" }),
          "runtime",
        ),
      /lowercase SQL identifier/,
    );
  });

  it("refuses identical owner and runtime roles", () => {
    refuses(
      () =>
        loadPostgresConfig(
          env({
            RELAYCAST_DATABASE_OWNER_ROLE: "same",
            RELAYCAST_DATABASE_RUNTIME_ROLE: "same",
          }),
          "runtime",
        ),
      /must differ/,
    );
  });

  it("refuses out-of-range pool and timeout settings", () => {
    refuses(
      () =>
        loadPostgresConfig(
          env({ RELAYCAST_DATABASE_POOL_MAX: "0" }),
          "runtime",
        ),
      /POOL_MAX must be between 1 and 100/,
    );
    refuses(
      () =>
        loadPostgresConfig(
          env({ RELAYCAST_DATABASE_POOL_MAX: "ten" }),
          "runtime",
        ),
      /POOL_MAX must be an integer/,
    );
    refuses(
      () =>
        loadPostgresConfig(
          env({ RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS: "86400001" }),
          "runtime",
        ),
      /STATEMENT_TIMEOUT_MS must be between/,
    );
  });
});

describe("readCaFile", () => {
  it("accepts a CA certificate and hashes the file bytes", () => {
    const { ca, caSha256 } = readCaFile(CA_FILE);
    expect(ca).toContain("BEGIN CERTIFICATE");
    expect(caSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses an unreadable file", () => {
    refuses(
      () => readCaFile("/nonexistent/relaycast-ca.pem"),
      /unreadable \(ENOENT\)/,
    );
  });

  it("refuses a bundle containing a private key", () => {
    const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const footer = ["-----END", "PRIVATE KEY-----"].join(" ");
    const ca = readCaFile(CA_FILE).ca;
    refuses(
      () => readCaFile(tmpFile(`${ca}\n${header}\nAAAA\n${footer}\n`)),
      /contains a private key/,
    );
  });

  it("refuses non-PEM content and unparseable certificates", () => {
    refuses(() => readCaFile(tmpFile("hello")), /not a PEM certificate bundle/);
    refuses(
      () =>
        readCaFile(
          tmpFile(
            "-----BEGIN CERTIFICATE-----\nnotbase64\n-----END CERTIFICATE-----\n",
          ),
        ),
      /does not parse/,
    );
  });

  it("refuses a bundle with no CA certificate", () => {
    refuses(() => readCaFile(LEAF_FILE), /no CA certificate/);
  });
});

describe("describePostgresConfig", () => {
  it("omits the URL, user and password", () => {
    const summary = describePostgresConfig(
      loadPostgresConfig(env(), "runtime"),
    );
    expect(Object.keys(summary).sort()).toEqual([
      "caSha256",
      "database",
      "expectedRole",
      "host",
      "mode",
      "port",
      "schema",
    ]);
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);
  });
});
