import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LogStreamer } from "../../packages/core/src/storage/log-streamer.js";

/** Mock ScopedS3Client that records all calls */
function createMockS3() {
  const calls: { method: string; args: any[] }[] = [];
  let partCounter = 0;

  return {
    calls,
    client: {
      createMultipartUpload(_key: string, _contentType?: string) {
        calls.push({ method: "createMultipartUpload", args: [_key, _contentType] });
        return Promise.resolve("upload-id-123");
      },
      uploadPart(_key: string, _uploadId: string, partNumber: number, _body: Buffer) {
        partCounter++;
        calls.push({ method: "uploadPart", args: [_key, _uploadId, partNumber] });
        return Promise.resolve(`etag-${partCounter}`);
      },
      completeMultipartUpload(_key: string, _uploadId: string, _parts: any[]) {
        calls.push({ method: "completeMultipartUpload", args: [_key, _uploadId, _parts] });
        return Promise.resolve();
      },
      abortMultipartUpload(_key: string, _uploadId: string) {
        calls.push({ method: "abortMultipartUpload", args: [_key, _uploadId] });
        return Promise.resolve();
      },
      putObject(_key: string, _body: Buffer | string, _contentType?: string) {
        calls.push({ method: "putObject", args: [_key] });
        return Promise.resolve();
      },
    } as any,
  };
}

describe("LogStreamer", () => {
  it("does not create multipart upload on start (lazy init)", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-1");

    await streamer.start();
    await streamer.abort(); // cleanup

    const methods = mock.calls.map((c) => c.method);
    assert.ok(!methods.includes("createMultipartUpload"));
  });

  it("throws if started twice", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-2");

    await streamer.start();
    await assert.rejects(() => streamer.start(), { message: /already started/i });
    await streamer.abort();
  });

  it("throws if write called before start", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-3");

    await assert.rejects(() => streamer.write("hello"), { message: /not active/i });
  });

  it("uses putObject for small logs on finish", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-4");

    await streamer.start();
    await streamer.write("small log output");
    await streamer.finish();

    // With lazy init, no multipart was created for small logs — just putObject
    const methods = mock.calls.map((c) => c.method);
    assert.ok(!methods.includes("createMultipartUpload"));
    assert.ok(methods.includes("putObject"));
    assert.ok(!methods.includes("completeMultipartUpload"));
  });

  it("uses multipart for large logs", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-5");

    await streamer.start();
    // Write two chunks that together exceed 5MB threshold
    const chunk1 = Buffer.alloc(3 * 1024 * 1024, "x");
    const chunk2 = Buffer.alloc(3 * 1024 * 1024, "y");
    await streamer.write(chunk1);
    await streamer.write(chunk2);
    await streamer.finish();

    const methods = mock.calls.map((c) => c.method);
    assert.ok(
      methods.includes("uploadPart"),
      `Expected uploadPart in: ${JSON.stringify(methods)}`
    );
    assert.ok(
      methods.includes("completeMultipartUpload"),
      `Expected completeMultipartUpload in: ${JSON.stringify(methods)}`
    );
  });

  it("handles abort gracefully", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-6");

    await streamer.start();
    await streamer.write("some data");
    await streamer.abort();

    // With lazy init, small data never triggers multipart creation
    const methods = mock.calls.map((c) => c.method);
    assert.ok(!methods.includes("createMultipartUpload"));
    assert.ok(!methods.includes("abortMultipartUpload"));
  });

  it("finish with no data does not create multipart", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-7");

    await streamer.start();
    await streamer.finish();

    // No data written, no multipart — but finish() writes a placeholder via putObject
    const methods = mock.calls.map((c) => c.method);
    assert.ok(!methods.includes("createMultipartUpload"));
    assert.ok(!methods.includes("abortMultipartUpload"));
    assert.ok(methods.includes("putObject"), "finish() should write placeholder log entry");
  });

  it("double finish is safe", async () => {
    const mock = createMockS3();
    const streamer = new LogStreamer(mock.client, "sandbox-8");

    await streamer.start();
    await streamer.write("data");
    await streamer.finish();
    await streamer.finish(); // should not throw

    assert.ok(true);
  });
});
