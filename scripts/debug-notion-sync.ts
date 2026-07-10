import { Nango, type ListRecordsRequestConfig, type ProxyConfiguration } from "@nangohq/node";
import { NotionAdapter, type NotionConnectionProvider } from "@relayfile/adapter-notion";
import {
  DiscriminatedNotionRecordSchema,
  NotionSupportedModelSchema,
  type NotionSupportedModel,
} from "@relayfile/provider-nango";
import { RelayFileClient, type ProxyRequest, type ProxyResponse } from "@relayfile/sdk";
import { Resource } from "sst";
import { mintRelayfileToken } from "../packages/core/src/relayfile/client.js";

const DEFAULT_PROVIDER_CONFIG_KEY = "notion-relay";
const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_RELAYFILE_URL = "https://api.relayfile.dev";
const DEFAULT_PAGE_SIZE = 100;

type DebugOptions = {
  models: NotionSupportedModel[];
  workspaceId: string;
  connectionId: string;
  providerConfigKey: string;
  modifiedAfter: string;
  nangoHost: string;
  relayfileUrl: string;
  limit: number | null;
  pageSize: number;
  parseOnly: boolean;
};

type ModelSummary = {
  total: number;
  successful: number;
  parseErrors: number;
  ingestErrors: number;
  partial: number;
  skippedDeleted: number;
  filesWritten: number;
  errorPatterns: Map<string, number>;
};
type ParsedNotionRecord = ReturnType<typeof DiscriminatedNotionRecordSchema.parse>;

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/debug-notion-sync.ts [options]

Options:
  --model <name>                NotionPage, NotionContentMetadata, or NotionDatabase. Repeatable.
  --workspace-id <id>           Workspace id. Defaults to WORKSPACE_ID or CLOUD_WORKSPACE_ID.
  --connection-id <id>          Nango connection id. Defaults to NOTION_CONNECTION_ID or NANGO_CONNECTION_ID.
  --provider-config-key <key>   Nango integration id. Defaults to notion-relay.
  --modified-after <timestamp>  Optional Nango modifiedAfter value.
  --limit <count>               Stop after count records per model.
  --page-size <count>           Nango listRecords page size. Defaults to 100.
  --parse-only                  Fetch and validate records without writing to RelayFile.
  --help                        Show this help.
`);
}

function parseInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv: string[]): DebugOptions {
  const models: NotionSupportedModel[] = [];
  const options: DebugOptions = {
    models,
    workspaceId: readEnv(["WORKSPACE_ID", "CLOUD_WORKSPACE_ID"]) ?? "",
    connectionId: readEnv(["NOTION_CONNECTION_ID", "NANGO_CONNECTION_ID"]) ?? "",
    providerConfigKey: DEFAULT_PROVIDER_CONFIG_KEY,
    modifiedAfter: "",
    nangoHost: process.env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST,
    relayfileUrl: process.env.RELAYFILE_URL?.trim() || DEFAULT_RELAYFILE_URL,
    limit: null,
    pageSize: DEFAULT_PAGE_SIZE,
    parseOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--model": {
        const model = readFlagValue(argv, index, arg);
        const parsed = NotionSupportedModelSchema.safeParse(model);
        if (!parsed.success) {
          throw new Error(`Unsupported --model value: ${model}`);
        }
        models.push(parsed.data);
        index += 1;
        break;
      }
      case "--workspace-id":
        options.workspaceId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--connection-id":
        options.connectionId = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--provider-config-key":
        options.providerConfigKey = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--modified-after":
        options.modifiedAfter = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parseInteger(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--page-size":
        options.pageSize = parseInteger(readFlagValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--parse-only":
        options.parseOnly = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (models.length === 0) {
    models.push("NotionPage", "NotionContentMetadata");
  }
  if (!options.workspaceId) {
    throw new Error("Missing workspace id. Pass --workspace-id or set WORKSPACE_ID/CLOUD_WORKSPACE_ID.");
  }
  if (!options.connectionId) {
    throw new Error(
      "Missing Notion connection id. Pass --connection-id or set NOTION_CONNECTION_ID/NANGO_CONNECTION_ID.",
    );
  }

  return options;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readResourceSecret(name: "NangoSecretKey" | "RelayJwtSecret"): string | null {
  try {
    const resources = Resource as unknown as Record<string, { value?: string } | undefined>;
    return resources[name]?.value?.trim() || null;
  } catch {
    return null;
  }
}

function readEnv(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function getNangoSecretKey(): string {
  const value =
    readEnv(["NANGO_SECRET_KEY", "NANGO_SECRET_KEY_PRODUCTION"]) ??
    readResourceSecret("NangoSecretKey");
  if (!value) {
    throw new Error("Missing Nango secret. Set NANGO_SECRET_KEY or run through sst shell.");
  }
  return value;
}

function getRelayJwtSecret(): string {
  const value =
    readEnv(["RELAY_JWT_SECRET", "RELAYFILE_JWT_SECRET"]) ??
    readResourceSecret("RelayJwtSecret");
  if (!value) {
    throw new Error("Missing Relay JWT secret. Set RELAY_JWT_SECRET or run through sst shell.");
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeProxyHeaders(headers: unknown): Record<string, string> {
  const maybeSerializable = headers as { toJSON?: () => unknown };
  const source =
    isObject(headers) && typeof maybeSerializable.toJSON === "function"
      ? maybeSerializable.toJSON()
      : headers;

  if (!isObject(source)) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    normalized[key] = Array.isArray(value)
      ? value.map(String).join(", ")
      : String(value);
  }
  return normalized;
}

function readProxyErrorResponse(
  error: unknown,
): { status: number; headers: unknown; data: unknown } | null {
  if (!isObject(error) || !isObject(error.response)) {
    return null;
  }

  const { status, headers, data } = error.response;
  if (typeof status !== "number") {
    return null;
  }

  return { status, headers, data };
}

async function proxyNotionRequest<T = unknown>(
  nangoClient: Nango,
  input: {
    connectionId: string;
    providerConfigKey: string;
  },
  request: ProxyRequest,
): Promise<ProxyResponse<T>> {
  const config: ProxyConfiguration = {
    method: request.method,
    endpoint: request.endpoint,
    connectionId: input.connectionId,
    providerConfigKey: input.providerConfigKey,
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.body === undefined ? {} : { data: request.body }),
    ...(request.query ? { params: request.query } : {}),
    ...(request.baseUrl ? { baseUrlOverride: request.baseUrl } : {}),
  };

  try {
    const response = await nangoClient.proxy<T>(config);
    return {
      status: response.status,
      headers: normalizeProxyHeaders(response.headers),
      data: response.data,
    };
  } catch (error) {
    const response = readProxyErrorResponse(error);
    if (!response) {
      throw error;
    }

    return {
      status: response.status,
      headers: normalizeProxyHeaders(response.headers),
      data: response.data as T,
    };
  }
}

function createNotionAdapter(input: {
  nangoClient: Nango;
  relayfileClient: RelayFileClient;
  connectionId: string;
  providerConfigKey: string;
}): NotionAdapter {
  const provider: NotionConnectionProvider = {
    name: "notion",
    async proxy(request) {
      return proxyNotionRequest(input.nangoClient, input, request);
    },
    async healthCheck(connectionId) {
      const response = await proxyNotionRequest(input.nangoClient, input, {
        method: "GET",
        baseUrl: "https://api.notion.com",
        endpoint: "/v1/users/me",
        connectionId,
        headers: { "Notion-Version": "2022-06-28" },
      });
      return response.status < 400;
    },
  };

  return new NotionAdapter(input.relayfileClient, provider, {
    connectionId: input.connectionId,
    fetchComments: false,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addErrorPattern(summary: ModelSummary, message: string): void {
  const normalized = message.replace(/\s+/g, " ").trim().slice(0, 300);
  summary.errorPatterns.set(
    normalized,
    (summary.errorPatterns.get(normalized) ?? 0) + 1,
  );
}

function summarizeZodError(error: {
  issues: Array<{ path: Array<string | number>; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function readRecordId(record: unknown): string {
  if (!isObject(record)) {
    return "";
  }
  const id = record.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

function readRecordAction(record: unknown): string {
  if (!isObject(record) || !isObject(record._nango_metadata)) {
    return "UNKNOWN";
  }
  const action = record._nango_metadata.last_action;
  return typeof action === "string" ? action.toUpperCase() : "UNKNOWN";
}

async function ingestParsedRecord(input: {
  adapter: NotionAdapter;
  workspaceId: string;
  parsed: ParsedNotionRecord;
}) {
  const { adapter, workspaceId, parsed } = input;

  switch (parsed.model) {
    case "NotionDatabase":
      return adapter.ingestDatabase(workspaceId, parsed.record.id);
    case "NotionPage": {
      const databaseId =
        parsed.record.parent_type === "database" && parsed.record.parent_id
          ? parsed.record.parent_id
          : undefined;
      return adapter.ingestPage(workspaceId, parsed.record.id, databaseId);
    }
    case "NotionContentMetadata":
      if (parsed.record.type === "database") {
        return adapter.ingestDatabase(workspaceId, parsed.record.id);
      }
      return adapter.ingestPage(workspaceId, parsed.record.id);
  }
}

function printSummary(model: NotionSupportedModel, summary: ModelSummary): void {
  console.log("");
  console.log("=== Summary ===");
  console.log(`Model: ${model}`);
  console.log(`Total records: ${summary.total}`);
  console.log(`Successful: ${summary.successful}`);
  console.log(`Parse errors: ${summary.parseErrors}`);
  console.log(`Ingest errors: ${summary.ingestErrors}`);
  console.log(`Partial writes: ${summary.partial}`);
  console.log(`Skipped (deleted): ${summary.skippedDeleted}`);
  console.log(`Files written: ${summary.filesWritten}`);

  if (summary.errorPatterns.size > 0) {
    console.log("");
    console.log("Top error patterns:");
    for (const [message, count] of [...summary.errorPatterns.entries()].sort(
      (left, right) => right[1] - left[1],
    ).slice(0, 10)) {
      console.log(`  ${count}x ${message}`);
    }
  }
}

async function debugModel(input: {
  options: DebugOptions;
  nangoClient: Nango;
  adapter: NotionAdapter | null;
  model: NotionSupportedModel;
}): Promise<void> {
  const { options, nangoClient, adapter, model } = input;
  const summary: ModelSummary = {
    total: 0,
    successful: 0,
    parseErrors: 0,
    ingestErrors: 0,
    partial: 0,
    skippedDeleted: 0,
    filesWritten: 0,
    errorPatterns: new Map(),
  };
  let cursor: string | null = null;

  console.log("");
  console.log(`=== Debugging ${model} ===`);

  do {
    const remaining =
      options.limit === null ? options.pageSize : options.limit - summary.total;
    if (remaining <= 0) {
      break;
    }

    const request: ListRecordsRequestConfig = {
      connectionId: options.connectionId,
      providerConfigKey: options.providerConfigKey,
      model,
      limit: Math.min(options.pageSize, remaining),
      ...(options.modifiedAfter ? { modifiedAfter: options.modifiedAfter } : {}),
      ...(cursor ? { cursor } : {}),
    };
    const page = await nangoClient.listRecords(request);

    for (const record of page.records) {
      summary.total += 1;

      const recordId = readRecordId(record);
      const action = readRecordAction(record);
      const prefix = `[${summary.total}] ${model} id=${recordId || "(missing)"} action=${action}`;

      if (action === "DELETED") {
        summary.skippedDeleted += 1;
        console.log(`${prefix} -> SKIPPED_DELETED`);
        continue;
      }

      const parsed = DiscriminatedNotionRecordSchema.safeParse({ model, record });
      if (!parsed.success) {
        const message = summarizeZodError(parsed.error);
        summary.parseErrors += 1;
        addErrorPattern(summary, message);
        console.log(`${prefix} -> PARSE_ERROR: ${message}`);
        console.log(`  raw=${JSON.stringify(record).slice(0, 500)}`);
        continue;
      }

      if (options.parseOnly) {
        summary.successful += 1;
        console.log(`${prefix} -> OK_PARSE_ONLY`);
        continue;
      }

      if (!adapter) {
        throw new Error("Internal error: Notion adapter is required unless --parse-only is set.");
      }

      try {
        const result = await ingestParsedRecord({
          adapter,
          workspaceId: options.workspaceId,
          parsed: parsed.data,
        });
        summary.filesWritten += result.filesWritten;

        if (result.errors.length > 0) {
          summary.partial += 1;
          const message = result.errors
            .map((entry) => `${entry.path}: ${entry.error}`)
            .join("; ");
          addErrorPattern(summary, message);
          console.log(
            `${prefix} -> PARTIAL: wrote ${result.filesWritten} files, ${result.errors.length} errors`,
          );
          for (const entry of result.errors) {
            console.log(`  - ${entry.path}: ${entry.error}`);
          }
        } else {
          summary.successful += 1;
          console.log(`${prefix} -> OK (wrote ${result.filesWritten} files)`);
        }
      } catch (error) {
        const message = errorMessage(error);
        summary.ingestErrors += 1;
        addErrorPattern(summary, message);
        console.log(`${prefix} -> INGEST_ERROR: ${message}`);
      }

      if (options.limit !== null && summary.total >= options.limit) {
        break;
      }
    }

    cursor = page.next_cursor?.trim() || null;
  } while (cursor);

  printSummary(model, summary);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const nangoClient = new Nango({
    secretKey: getNangoSecretKey(),
    host: trimTrailingSlash(options.nangoHost),
  });
  const adapter = options.parseOnly
    ? null
    : createNotionAdapter({
        nangoClient,
        relayfileClient: new RelayFileClient({
          baseUrl: options.relayfileUrl,
          token: mintRelayfileToken(
            options.workspaceId,
            getRelayJwtSecret(),
            "debug-notion-sync",
          ),
        }),
        connectionId: options.connectionId,
        providerConfigKey: options.providerConfigKey,
      });

  for (const model of options.models) {
    await debugModel({ options, nangoClient, adapter, model });
  }
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
