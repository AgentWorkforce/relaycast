import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  CreateQueueCommand,
  SQSClient,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";

const execFileAsync = promisify(execFile);

export interface LocalstackSqsOptions {
  containerName?: string;
  image?: string;
  port?: number;
  queueNames?: string[];
}

async function waitForLocalstack(endpoint: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/_localstack/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the container is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for LocalStack at ${endpoint}`);
}

export async function startLocalstackSqs(options: LocalstackSqsOptions = {}) {
  const containerName = options.containerName ?? "cloud-web-handler-localstack";
  const image = options.image ?? "localstack/localstack:3";
  const port = options.port ?? 4566;
  const endpoint = `http://127.0.0.1:${port}`;

  try {
    await execFileAsync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      "SERVICES=sqs",
      "-p",
      `${port}:4566`,
      image,
    ]);
  } catch (error) {
    throw new Error(
      `Failed to start LocalStack SQS via docker: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await waitForLocalstack(endpoint);

  const clientConfig: SQSClientConfig = {
    endpoint,
    region: "us-east-1",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  };
  const client = new SQSClient(clientConfig);
  const queueUrls = new Map<string, string>();

  for (const queueName of options.queueNames ?? []) {
    const result = await client.send(new CreateQueueCommand({ QueueName: queueName }));
    if (!result.QueueUrl) {
      throw new Error(`LocalStack did not return a queue URL for ${queueName}`);
    }
    queueUrls.set(queueName, result.QueueUrl);
  }

  return {
    endpoint,
    client,
    queueUrls,
    async stop() {
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
    },
  };
}
