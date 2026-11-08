import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { PostgresConfig } from "../config.js";
import {
  closePostgresPool,
  openPostgresPool,
  parseInt8,
  postgresPoolOptions,
  postgresTlsOptions,
} from "../pool.js";

const pem = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    "utf8",
  );

function config(overrides: Partial<PostgresConfig> = {}): PostgresConfig {
  return {
    mode: "runtime",
    host: "db.example.test",
    port: 5432,
    database: "app",
    user: "relaycast_runtime",
    password: "dev-only",
    ca: pem("test-ca.pem"),
    caSha256: "0".repeat(64),
    schema: "relaycast",
    ownerRole: "relaycast_owner",
    runtimeRole: "relaycast_runtime",
    expectedRole: "relaycast_runtime",
    poolMax: undefined,
    statementTimeoutMs: undefined,
    ...overrides,
  };
}

/** Node's tls.checkServerIdentity takes a PeerCertificate; the fields it reads are subject and subjectaltname. */
function peer(name: string) {
  const cert = new X509Certificate(pem(name));
  return {
    subject: { CN: "db.example.test" },
    subjectaltname: cert.subjectAltName,
  } as never;
}

describe("postgresTlsOptions", () => {
  it("pins the CA, verifies the chain and requires TLS 1.2+", () => {
    const tls = postgresTlsOptions(config());
    expect(tls.ca).toContain("BEGIN CERTIFICATE");
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.minVersion).toBe("TLSv1.2");
    expect(tls).toMatchObject({ servername: "db.example.test" });
  });

  it("omits SNI for IP literals but still verifies the IP SAN", () => {
    const tls = postgresTlsOptions(config({ host: "10.0.0.5" }));
    expect(tls).not.toHaveProperty("servername");
    expect(
      tls.checkServerIdentity("localhost", peer("test-leaf.pem")),
    ).toBeUndefined();
    const wrong = postgresTlsOptions(config({ host: "10.0.0.6" }));
    expect(
      wrong.checkServerIdentity("localhost", peer("test-leaf.pem")),
    ).toBeInstanceOf(Error);
  });

  it("checks the configured host name, not the servername node-postgres passes", () => {
    const ok = postgresTlsOptions(config());
    expect(
      ok.checkServerIdentity("localhost", peer("test-leaf.pem")),
    ).toBeUndefined();
    const bad = postgresTlsOptions(config({ host: "evil.example.test" }));
    expect(
      bad.checkServerIdentity("db.example.test", peer("test-leaf.pem")),
    ).toBeInstanceOf(Error);
  });
});

describe("postgresPoolOptions", () => {
  it("sets identity, search_path, application_name and TLS", () => {
    const opts = postgresPoolOptions(
      config({ poolMax: 4, statementTimeoutMs: 5000 }),
    );
    expect(opts).toMatchObject({
      host: "db.example.test",
      port: 5432,
      database: "app",
      user: "relaycast_runtime",
      application_name: "relaycast-engine:runtime",
      options: "-c search_path=relaycast",
      statement_timeout: 5000,
      max: 4,
    });
    expect(opts.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(opts).not.toHaveProperty("connectionString");
  });

  it("leaves pool size and timeout at driver defaults when unset", () => {
    const opts = postgresPoolOptions(config());
    expect(opts).not.toHaveProperty("max");
    expect(opts).not.toHaveProperty("statement_timeout");
  });

  it("parses int8 to numbers through the type overrides", () => {
    const opts = postgresPoolOptions(config());
    const types = opts.types as {
      getTypeParser(oid: number, format?: string): (v: string) => unknown;
    };
    expect(types.getTypeParser(20, "text")("42")).toBe(42);
  });
});

describe("parseInt8", () => {
  it("returns safe integers and refuses larger values", () => {
    expect(parseInt8("-9007199254740991")).toBe(-9007199254740991);
    expect(() => parseInt8("9007199254740993")).toThrow(RangeError);
  });
});

describe("connection parameters", () => {
  const poisoned = {
    PGHOST: "evil.example.test",
    PGPORT: "1",
    PGUSER: "postgres",
    PGPASSWORD: "from-env",
    PGDATABASE: "postgres",
    PGSSLMODE: "disable",
    PGOPTIONS: "-c search_path=public",
    PGAPPNAME: "other",
  };
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("are the sanitized discrete fields, unaffected by PG* environment variables", () => {
    for (const [k, v] of Object.entries(poisoned)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new pg.Client(postgresPoolOptions(config()));
    const params = (
      client as unknown as { connectionParameters: Record<string, unknown> }
    ).connectionParameters;
    expect(params).toMatchObject({
      host: "db.example.test",
      port: 5432,
      user: "relaycast_runtime",
      database: "app",
      options: "-c search_path=relaycast",
      application_name: "relaycast-engine:runtime",
    });
    expect(params.password).toBe("dev-only");
    expect(params.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: "db.example.test",
    });
    expect(params).not.toHaveProperty("connectionString");
  });
});

describe("openPostgresPool idle-client errors", () => {
  it("logs the error message only, never the config, and does not throw", async () => {
    const lines: string[] = [];
    const pool = openPostgresPool(config({ password: "pw-dev-only-321" }), {
      log: (l) => lines.push(l),
    });
    try {
      pool.emit("error", new Error("terminating connection due to administrator command"));
      expect(lines).toEqual([
        "postgres pool: idle client error: terminating connection due to administrator command",
      ]);
      expect(lines.join("\n")).not.toMatch(/pw-dev-only-321|db\.example\.test|relaycast_runtime/);
    } finally {
      await closePostgresPool(pool);
    }
  });

  it("still swallows idle-client errors when no log is given", async () => {
    const pool = openPostgresPool(config());
    try {
      expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
    } finally {
      await closePostgresPool(pool);
    }
  });
});
