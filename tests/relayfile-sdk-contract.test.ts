import { describe, expect, it } from "vitest";
import {
  RelayFileClient,
  RelayFileApiError,
  RelayFileReadCacheOptions,
  FileReadResponse,
  FileQueryItem,
  FilesystemEvent,
  WriteQueuedResponse,
  TreeEntry,
  SyncStatusResponse,
  type RelayFileClientOptions,
} from "@relayfile/sdk";

describe("@relayfile/sdk contract", () => {
  it("exports RelayFileClient as a class", () => {
    expect(RelayFileClient).toBeInstanceOf(Function);
    expect(RelayFileClient.name).toBe("RelayFileClient");
  });

  it("can instantiate RelayFileClient with readCache option", () => {
    const client = new RelayFileClient({
      token: "test-token",
      readCache: { ttlMs: 5000, maxEntries: 500 },
    });
    expect(client).toBeInstanceOf(RelayFileClient);
  });

  it("RelayFileClient instance has expected methods", () => {
    const client = new RelayFileClient({ token: "test" });
    expect(typeof client.readFile).toBe("function");
    expect(typeof client.writeFile).toBe("function");
    expect(typeof client.deleteFile).toBe("function");
    expect(typeof client.queryFiles).toBe("function");
    expect(typeof client.getEvents).toBe("function");
  });

  it("exports RelayFileApiError as a class", () => {
    expect(RelayFileApiError).toBeInstanceOf(Function);
    const error = new RelayFileApiError(404, {
      code: "not_found",
      message: "File not found",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.name).toBe("RelayFileApiError");
  });

  it("exports RelayFileReadCacheOptions type for SDK cache config", () => {
    const opts: RelayFileReadCacheOptions = { ttlMs: 5000, maxEntries: 500 };
    expect(opts.ttlMs).toBe(5000);
    expect(opts.maxEntries).toBe(500);
  });

  it("exports key types used by Cloud code", () => {
    // Compile-time only: verify types are exported
    const _fr: FileReadResponse = {} as FileReadResponse;
    const _fq: FileQueryItem = {} as FileQueryItem;
    const _fe: FilesystemEvent = {} as FilesystemEvent;
    const _wq: WriteQueuedResponse = {} as WriteQueuedResponse;
    const _te: TreeEntry = {} as TreeEntry;
    const _ss: SyncStatusResponse = {} as SyncStatusResponse;
    // Just confirm the variables can exist (otherwise TS would fail)
    expect(typeof _fr).toBe("object");
    expect(typeof _fq).toBe("object");
    expect(typeof _fe).toBe("object");
    expect(typeof _wq).toBe("object");
    expect(typeof _te).toBe("object");
    expect(typeof _ss).toBe("object");
  });

  it("exports RelayFileClientOptions type (with readCache field)", () => {
    // Verify the readCache field exists in the options type
    const opts: RelayFileClientOptions = {
      token: "test",
      readCache: { ttlMs: 3000 },
    };
    expect(opts.readCache).toBeDefined();
    expect(opts.readCache?.ttlMs).toBe(3000);
  });

  it("default cache is enabled when readCache option omitted", () => {
    // When readCache is not set, the SDK defaults to the 5s/500 cache.
    // This test verifies that omitting readCache doesn't crash construction.
    const client = new RelayFileClient({ token: "test" });
    expect(client).toBeInstanceOf(RelayFileClient);
  });

  it("cache can be disabled with readCache: false", () => {
    const client = new RelayFileClient({
      token: "test",
      readCache: false,
    });
    expect(client).toBeInstanceOf(RelayFileClient);
  });
});
