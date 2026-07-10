import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getDaytonaCredentialFromStore } from "../src/auth/cli-credentials.js";
import { refreshCredential } from "../src/auth/credential-refresher.js";
import {
  CredentialStore,
  type DaytonaCredential,
} from "../src/auth/credential-store.js";
import { normalizeStoredCredentialForProvider } from "../src/auth/sandbox-auth.js";

const ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const DAYTONA_CREDENTIAL: DaytonaCredential = {
  provider: "daytona",
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token",
  expiresAt: "2026-06-12T12:00:00.000Z",
  orgId: "org-123",
};

function bodyFromString(value: string): AsyncIterable<Uint8Array> {
  return (async function* body() {
    yield Buffer.from(value);
  })();
}

class InMemoryS3Client {
  objects = new Map<string, string>();

  async send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) {
    if (command instanceof PutObjectCommand) {
      const key = String(command.input.Key);
      const body = command.input.Body;
      this.objects.set(key, typeof body === "string" ? body : String(body));
      return {};
    }

    if (command instanceof GetObjectCommand) {
      const key = String(command.input.Key);
      const value = this.objects.get(key);
      if (value === undefined) {
        throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      }
      return { Body: bodyFromString(value) };
    }

    if (command instanceof DeleteObjectCommand) {
      const key = String(command.input.Key);
      this.objects.delete(key);
      return {};
    }

    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
}

const realFetch = globalThis.fetch;
const realDaytonaClientId = process.env.DAYTONA_AUTH0_CLIENT_ID;
const realDaytonaClientSecret = process.env.DAYTONA_AUTH0_CLIENT_SECRET;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realDaytonaClientId === undefined) {
    delete process.env.DAYTONA_AUTH0_CLIENT_ID;
  } else {
    process.env.DAYTONA_AUTH0_CLIENT_ID = realDaytonaClientId;
  }
  if (realDaytonaClientSecret === undefined) {
    delete process.env.DAYTONA_AUTH0_CLIENT_SECRET;
  } else {
    process.env.DAYTONA_AUTH0_CLIENT_SECRET = realDaytonaClientSecret;
  }
});

test("normalizeStoredCredentialForProvider maps Daytona config active profile to stored credential shape", () => {
  const credentialJson = normalizeStoredCredentialForProvider(
    "daytona",
    JSON.stringify({
      activeProfile: "work",
      profiles: [
        {
          id: "personal",
          api: {
            token: {
              accessToken: "personal-access",
              refreshToken: "personal-refresh",
              expiresAt: "2026-06-12T10:00:00.000Z",
            },
          },
          activeOrganizationId: "org-personal",
        },
        {
          id: "work",
          api: {
            token: {
              accessToken: "work-access",
              refreshToken: "work-refresh",
              expiresAt: "2026-06-12T11:00:00.000Z",
            },
          },
          activeOrganizationId: "org-work",
        },
      ],
    }),
  );

  assert.deepEqual(JSON.parse(credentialJson), {
    provider: "daytona",
    accessToken: "work-access",
    refreshToken: "work-refresh",
    expiresAt: "2026-06-12T11:00:00.000Z",
    orgId: "org-work",
  });
});

test("refreshCredential('daytona') refreshes via Auth0 confidential client and persists rotated refresh token", async () => {
  process.env.DAYTONA_AUTH0_CLIENT_ID = "daytona-client-id";
  process.env.DAYTONA_AUTH0_CLIENT_SECRET = "daytona-client-secret";
  let capturedUrl = "";
  let capturedBody = "";
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    capturedUrl = String(url);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 86400,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const before = Date.now();
  const result = await refreshCredential(
    "daytona",
    JSON.stringify(DAYTONA_CREDENTIAL),
  );

  assert.equal(capturedUrl, "https://daytonaio.us.auth0.com/oauth/token");
  const params = new URLSearchParams(capturedBody);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "old-refresh-token");
  assert.equal(params.get("client_id"), "daytona-client-id");
  assert.equal(params.get("client_secret"), "daytona-client-secret");
  assert.equal(params.has("audience"), false);
  assert.equal(params.has("scope"), false);

  const updated = JSON.parse(result.credentialJson) as DaytonaCredential;
  assert.equal(updated.provider, "daytona");
  assert.equal(updated.accessToken, "new-access-token");
  assert.equal(updated.refreshToken, "new-refresh-token");
  assert.equal(updated.orgId, "org-123");

  assert.ok(result.expiresAt);
  const expiresMs = result.expiresAt.getTime();
  assert.ok(expiresMs >= before + 86_400_000 - 5_000);
  assert.ok(expiresMs <= Date.now() + 86_400_000 + 5_000);
  assert.equal(new Date(updated.expiresAt).getTime(), expiresMs);
});

test("refreshCredential('daytona') keeps the stored refresh token when Auth0 omits rotation", async () => {
  process.env.DAYTONA_AUTH0_CLIENT_ID = "daytona-client-id";
  process.env.DAYTONA_AUTH0_CLIENT_SECRET = "daytona-client-secret";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "new-access-token",
        expires_in: 86400,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const result = await refreshCredential(
    "daytona",
    JSON.stringify(DAYTONA_CREDENTIAL),
  );
  const updated = JSON.parse(result.credentialJson) as DaytonaCredential;
  assert.equal(updated.accessToken, "new-access-token");
  assert.equal(updated.refreshToken, "old-refresh-token");
});

test("CredentialStore roundtrips a Daytona credential and getter refreshes stale stored token", async () => {
  process.env.DAYTONA_AUTH0_CLIENT_ID = "daytona-client-id";
  process.env.DAYTONA_AUTH0_CLIENT_SECRET = "daytona-client-secret";
  const s3 = new InMemoryS3Client();
  const store = new CredentialStore({
    bucket: "workflow-storage-test",
    prefix: "credentials",
    encryptionKey: ENCRYPTION_KEY,
    client: s3 as never,
  });

  await store.store("user-1", "daytona", JSON.stringify(DAYTONA_CREDENTIAL));
  assert.deepEqual(
    JSON.parse((await store.retrieve("user-1", "daytona")) ?? ""),
    DAYTONA_CREDENTIAL,
  );

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 86400,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const credential = await getDaytonaCredentialFromStore(store, "user-1");
  assert.equal(credential.accessToken, "fresh-access-token");
  assert.equal(credential.refreshToken, "fresh-refresh-token");
  assert.equal(credential.orgId, "org-123");

  assert.deepEqual(
    JSON.parse((await store.retrieve("user-1", "daytona")) ?? ""),
    credential,
  );
});
