import { beforeEach, describe, expect, it, vi } from "vitest";

const awsMocks = vi.hoisted(() => ({
  SQSClient: vi.fn(function SQSClient(this: { config?: unknown }, config: unknown) {
    this.config = config;
  }),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: awsMocks.SQSClient,
}));

import {
  createSqsClientForQueueUrl,
  resolveSqsRegionFromQueueUrl,
} from "./sqs-client";

describe("sqs-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives the AWS region from a standard SQS queue URL", () => {
    expect(
      resolveSqsRegionFromQueueUrl("https://sqs.us-east-1.amazonaws.com/123456789012/workflow-launch"),
    ).toBe("us-east-1");
  });

  it("constructs the SQS client with the queue URL region", () => {
    createSqsClientForQueueUrl("https://sqs.eu-north-1.amazonaws.com/123456789012/workflow-launch");

    expect(awsMocks.SQSClient).toHaveBeenCalledWith({ region: "eu-north-1" });
  });

  it("throws when no region can be resolved", () => {
    expect(() => createSqsClientForQueueUrl("not-a-url")).toThrow(
      "Could not resolve AWS region from SQS queue URL: not-a-url",
    );
  });
});
