import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CredentialStore,
  type CredentialStoreMetadata,
} from "../src/auth/credential-store.js";
import {
  credentialCryptoRuntimeInfo,
  decryptCredential,
  decryptCredentialAsync,
  encryptCredential,
  encryptCredentialAsync,
} from "../src/auth/credential-encryption.js";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function bodyFromString(value: string): AsyncIterable<Uint8Array> {
  return (async function* body() {
    yield Buffer.from(value);
  })();
}

class InMemoryS3Client {
  objects = new Map<string, string>();
  deletedKeys: string[] = [];

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
      this.deletedKeys.push(key);
      return {};
    }

    throw new Error(`Unsupported command ${command.constructor.name}`);
  }
}

test("async credential encryption is compatible with existing envelopes", async () => {
  const plaintext = JSON.stringify({ token: "secret" });

  const syncEnvelope = encryptCredential(plaintext, ENCRYPTION_KEY);
  assert.equal(credentialCryptoRuntimeInfo(syncEnvelope).selectedDecryptBranch, "webcrypto");
  assert.equal(await decryptCredentialAsync(syncEnvelope, ENCRYPTION_KEY), plaintext);

  const asyncEnvelope = await encryptCredentialAsync(plaintext, ENCRYPTION_KEY);
  assert.equal(decryptCredential(asyncEnvelope, ENCRYPTION_KEY), plaintext);
});

test("async credential encryption does not require global Buffer", async () => {
  const plaintext = JSON.stringify({ token: "worker-secret" });
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");

  Object.defineProperty(globalThis, "Buffer", {
    configurable: true,
    value: undefined,
  });
  try {
    const envelope = await encryptCredentialAsync(plaintext, ENCRYPTION_KEY);
    assert.equal(await decryptCredentialAsync(envelope, ENCRYPTION_KEY), plaintext);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "Buffer", originalDescriptor);
    }
  }
});

test("CredentialStore.delete removes the credential object and metadata entry", async () => {
  const s3 = new InMemoryS3Client();
  const store = new CredentialStore({
    bucket: "workflow-storage-test",
    prefix: "credentials",
    encryptionKey: ENCRYPTION_KEY,
    client: s3 as never,
  });

  await store.store("user-1", "anthropic", JSON.stringify({ token: "secret" }));
  assert.equal(
    await store.retrieve("user-1", "anthropic"),
    JSON.stringify({ token: "secret" }),
  );
  assert.equal((await store.getMetadata("user-1"))?.providers.anthropic.provider, "anthropic");

  await store.delete("user-1", "anthropic");

  assert.deepEqual(s3.deletedKeys, [
    "credentials/user-1/anthropic/credentials.json.enc",
  ]);
  assert.equal(await store.retrieve("user-1", "anthropic"), null);
  const metadata = (await store.getMetadata("user-1")) as CredentialStoreMetadata;
  assert.ok(metadata);
  assert.equal(metadata.providers.anthropic, undefined);
});
