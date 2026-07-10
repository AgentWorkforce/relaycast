import { Buffer } from "node:buffer";
import { Daytona } from "@daytonaio/sdk";
import { resolveDaytonaAuthCredentials } from "@cloud/core/auth/credentials.js";
import { DaytonaRuntime, type DaytonaRuntimeOptions, type RuntimeHandle } from "@cloud/core/runtime/daytona.js";
import { configureDaytonaFetchFirstAdapter } from "@/lib/daytona-fetch-adapter";
import { optionalEnv } from "@/lib/env";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";

export type DeploymentRunScriptResult = {
  output: string;
  stdout?: string;
  stderr?: string;
  exitCode: number | null;
  cmdId?: string;
};

export type DeploymentAsyncRunStartResult = {
  sessionId: string;
  commandId: string;
};

export type DeploymentAsyncRunStatus = {
  exitCode: number | null;
};

export type DeploymentSandboxRuntime = {
  readonly id: string;
  findByLabels(
    labels: Record<string, string>,
    options?: { states?: readonly string[] | null; limit?: number; pageSize?: number; owned?: boolean },
  ): Promise<RuntimeHandle | null>;
  findAllByLabels(
    labels: Record<string, string>,
    options?: { states?: readonly string[] | null; limit?: number; pageSize?: number; owned?: boolean },
  ): Promise<RuntimeHandle[]>;
  launch(options?: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  }): Promise<RuntimeHandle>;
  launchDetached?(options?: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  }): Promise<RuntimeHandle>;
  getById?(
    id: string,
    options?: { states?: readonly string[] | null; owned?: boolean },
  ): Promise<RuntimeHandle | null>;
  uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void>;
  runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<DeploymentRunScriptResult>;
  startScript?(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    suppressInputEcho?: boolean;
  }): Promise<DeploymentAsyncRunStartResult>;
  getScriptStatus?(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<DeploymentAsyncRunStatus>;
  getScriptLogs?(
    handle: RuntimeHandle,
    sessionId: string,
    commandId: string,
  ): Promise<DeploymentRunScriptResult>;
  start?(handle: RuntimeHandle): Promise<RuntimeHandle>;
  stop?(handle: RuntimeHandle): Promise<void>;
  destroy(handle: RuntimeHandle): Promise<void>;
};

export function createDeploymentSandboxRuntime(input: {
  snapshot?: string;
} = {}): DeploymentSandboxRuntime {
  const provider = (optionalEnv("SANDBOX_PROVIDER") || "daytona").trim().toLowerCase();
  if (provider === "local") {
    const baseUrl = optionalEnv("LOCAL_SANDBOX_URL")?.trim();
    if (!baseUrl) {
      throw new Error("LOCAL_SANDBOX_URL is required when SANDBOX_PROVIDER=local");
    }
    return new LocalSandboxProviderRuntime({ baseUrl });
  }
  if (provider !== "daytona") {
    throw new Error(`Unsupported SANDBOX_PROVIDER "${provider}"`);
  }
  return new DaytonaRuntime({
    daytona: createDaytonaClient(),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
  });
}

function createDaytonaClient(): DaytonaRuntimeOptions["daytona"] {
  const params = resolveServerDaytonaAuthParams();
  configureDaytonaFetchFirstAdapter();
  return new Daytona(resolveDaytonaAuthCredentials({
    apiKey: params.daytonaApiKey,
    jwtToken: params.daytonaJwtToken,
    organizationId: params.daytonaOrganizationId,
  }));
}

type LocalSandboxProviderRuntimeOptions = {
  baseUrl: string;
};

type LocalSandboxRecord = {
  id?: string;
  sandboxId?: string;
  state?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  homeDir?: string;
  workdir?: string;
};

class LocalSandboxProviderRuntime implements DeploymentSandboxRuntime {
  readonly id = "local";

  private readonly baseUrl: string;

  constructor(options: LocalSandboxProviderRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async findByLabels(
    labels: Record<string, string>,
    options: { states?: readonly string[] | null; limit?: number; pageSize?: number; owned?: boolean } = {},
  ): Promise<RuntimeHandle | null> {
    const handles = await this.findAllByLabels(labels, options);
    return handles[0] ?? null;
  }

  async findAllByLabels(
    labels: Record<string, string>,
    options: { states?: readonly string[] | null; limit?: number; pageSize?: number; owned?: boolean } = {},
  ): Promise<RuntimeHandle[]> {
    const states = options.states === undefined ? ["STARTED"] : options.states;
    const limit = options.limit ?? options.pageSize;
    const handles: RuntimeHandle[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(`${this.baseUrl}/sandboxes`);
      for (const [key, value] of Object.entries(labels)) {
        url.searchParams.append(key, value);
        url.searchParams.append(`label.${key}`, value);
      }
      if (limit) {
        url.searchParams.set("limit", String(limit));
      }
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      const response = await fetch(url);
      if (response.status === 404 || response.status === 501) {
        return handles;
      }
      await assertOk(response, "find local sandbox");
      const body = await response.json() as {
        items?: LocalSandboxRecord[];
        sandboxes?: LocalSandboxRecord[];
        nextCursor?: unknown;
        nextToken?: unknown;
      };
      const items = body.items ?? body.sandboxes ?? [];
      handles.push(
        ...items
          .filter((item) => matchesState(item, states))
          .map((item) => handleFromLocalRecord(item)),
      );
      cursor = readNextCursor(body, cursor);
    } while (cursor);
    return handles;
  }

  async launch(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    const response = await fetch(`${this.baseUrl}/sandboxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: options.name,
        env: options.env ?? {},
        envVars: options.env ?? {},
        labels: options.labels ?? {},
        timeoutSeconds: options.createTimeoutSeconds,
      }),
    });
    await assertOk(response, "create local sandbox");
    return handleFromLocalRecord(await response.json() as LocalSandboxRecord);
  }

  async launchDetached(options: {
    name?: string;
    env?: Record<string, string>;
    labels?: Record<string, string>;
    createTimeoutSeconds?: number;
  } = {}): Promise<RuntimeHandle> {
    return this.launch(options);
  }

  async getById(
    id: string,
    options: { states?: readonly string[] | null; owned?: boolean } = {},
  ): Promise<RuntimeHandle | null> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(id)}`);
    if (response.status === 404) {
      return null;
    }
    await assertOk(response, "get local sandbox");
    const handle = handleFromLocalRecord(await response.json() as LocalSandboxRecord);
    return matchesState(handle, options.states === undefined ? null : options.states) ? handle : null;
  }

  async uploadBundle(handle: RuntimeHandle, options: {
    files: Array<{ source: string | Buffer; destination: string }>;
  }): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: options.files.map((file) => ({
          source: Buffer.isBuffer(file.source)
            ? file.source.toString("base64")
            : Buffer.from(file.source, "utf8").toString("base64"),
          destination: file.destination,
        })),
      }),
    });
    await assertOk(response, "upload local sandbox files");
  }

  async runScript(handle: RuntimeHandle, options: {
    command: string;
    sessionId?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<DeploymentRunScriptResult> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: options.command,
        sessionId: options.sessionId,
        env: options.env,
        timeoutSeconds: options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
      }),
    });
    await assertOk(response, "execute local sandbox command");
    const body = await response.json() as Partial<DeploymentRunScriptResult> & {
      result?: string;
    };
    return {
      output: body.output ?? body.stdout ?? body.stderr ?? body.result ?? "",
      ...(body.stdout ? { stdout: body.stdout } : {}),
      ...(body.stderr ? { stderr: body.stderr } : {}),
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      ...(body.cmdId ? { cmdId: body.cmdId } : {}),
    };
  }

  async destroy(handle: RuntimeHandle): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}`, {
      method: "DELETE",
    });
    if (response.status === 404) {
      return;
    }
    await assertOk(response, "delete local sandbox");
  }

  async stop(handle: RuntimeHandle): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/stop`, {
      method: "POST",
    });
    if (response.status === 404 || response.status === 501) {
      return;
    }
    await assertOk(response, "stop local sandbox");
  }

  async start(handle: RuntimeHandle): Promise<RuntimeHandle> {
    const response = await fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(handle.id)}/start`, {
      method: "POST",
    });
    if (response.status === 404 || response.status === 501) {
      return handle;
    }
    await assertOk(response, "start local sandbox");
    const body = await response.json().catch(() => null) as LocalSandboxRecord | null;
    return body ? handleFromLocalRecord(body) : { ...handle, state: "STARTED" };
  }
}

function handleFromLocalRecord(record: LocalSandboxRecord): RuntimeHandle {
  const id = record.sandboxId ?? record.id;
  if (!id) {
    throw new Error("Local sandbox response is missing sandboxId");
  }
  return {
    id,
    ...((record.state ?? record.status) ? { state: record.state ?? record.status } : {}),
    ...(record.createdAt ? { createdAt: record.createdAt } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    ...(record.lastActivityAt ? { lastActivityAt: record.lastActivityAt } : {}),
    ...(record.homeDir ? { homeDir: record.homeDir } : {}),
    ...(record.workdir ? { workdir: record.workdir } : {}),
  };
}

function readNextCursor(
  body: { nextCursor?: unknown; nextToken?: unknown; cursor?: unknown },
  currentCursor?: string,
): string | undefined {
  for (const value of [body.nextCursor, body.nextToken, body.cursor]) {
    if (typeof value === "string" && value.length > 0 && value !== currentCursor) {
      return value;
    }
  }
  return undefined;
}

function matchesState(record: LocalSandboxRecord, states: readonly string[] | null): boolean {
  if (states === null) {
    return true;
  }
  const rawState = (record.state ?? record.status ?? "STARTED").toUpperCase();
  const state = rawState === "RUNNING" ? "STARTED" : rawState;
  return states.includes(state);
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text().catch(() => "");
  throw new Error(`Failed to ${action}: HTTP ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
}
