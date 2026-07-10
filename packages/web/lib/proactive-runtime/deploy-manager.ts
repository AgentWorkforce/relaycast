import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type ts from "typescript";
import { Daytona } from "@daytonaio/sdk";
import { configureDaytonaFetchFirstAdapter } from "@/lib/daytona-fetch-adapter";
import { getSnapshotName } from "@cloud/core/config/snapshot.js";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sandboxes } from "@/lib/db/schema";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { resolveAgentGatewayBaseUrl } from "@/lib/proactive-runtime/dashboard";
import type { ProactiveDeployContext } from "@/lib/proactive-runtime/deploy-auth";
import {
  deleteDeploymentRecord,
  listDeploymentRecords,
  readDeploymentRecord,
  writeDeploymentRecord,
  type AgentTriggerManifest,
  type ProactiveDeploymentRecord,
} from "@/lib/proactive-runtime/deploy-store";
import {
  resolveHostedProviderEnvironment,
  type HostedProviderConfig,
} from "@/lib/proactive-runtime/hosted-provider";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";

const SUPERVISOR_FILENAME = "supervisor.mjs";
const BUNDLE_FILENAME = "agent.mjs";
const STATUS_FILENAME = "status.json";
const LOG_FILENAME = "runtime.log";
const WORKDIR_ROOT = "/home/daytona/proactive-agent";
const DEFAULT_GATEWAY_EVENTS_URL = "ws://127.0.0.1:8787/v1/agent-events";
let typescriptModule: typeof import("typescript") | null = null;

function resolveDaytonaSdkConfig(): ConstructorParameters<typeof Daytona>[0] {
  configureDaytonaFetchFirstAdapter();
  const params = resolveServerDaytonaAuthParams();
  if (params.daytonaApiKey) {
    return { apiKey: params.daytonaApiKey };
  }
  return {
    jwtToken: params.daytonaJwtToken,
    organizationId: params.daytonaOrganizationId,
  };
}

type EsbuildModule = typeof import("esbuild");

type DeploySourceInput = {
  entrypoint: string;
  source: string;
  name?: string;
  sourceKind?: "entrypoint" | "hosted-custom" | "hosted-default";
  hosted?: {
    model: string;
    instructions: string;
    provider: HostedProviderConfig;
  } | null;
};

type HostedDeployInput = {
  name: string;
  model: string;
  instructions: string;
  provider: HostedProviderConfig;
  schedule?: unknown;
  watch?: unknown;
  inbox?: unknown;
  runtime: {
    mode?: unknown;
    onEventSource?: unknown;
  };
};

type DeployResponse = {
  deploymentId: string;
  agentId: string;
  workspaceId: string;
  status: string;
  dashboardUrl?: string;
  logsUrl?: string;
};

type RuntimeStatusPayload = {
  state?: string;
  childPid?: number;
  restarts?: number;
  lastExitCode?: number | null;
  lastExitSignal?: string | null;
  updatedAt?: string;
};

function getTypeScript(): typeof import("typescript") {
  if (typescriptModule) {
    return typescriptModule;
  }
  const require = createRequire(import.meta.url);
  const loaded = require("../../../../node_modules/typescript/lib/typescript.js") as typeof import("typescript");
  typescriptModule = loaded;
  return loaded;
}

function normalizeGatewayEventsUrl(): string {
  const configured = resolveAgentGatewayBaseUrl()?.trim() || process.env.RELAY_AGENT_EVENTS_URL?.trim();
  if (!configured) {
    return DEFAULT_GATEWAY_EVENTS_URL;
  }

  const url = new URL(configured);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/v1/agent-events";
  }
  if (!url.pathname.endsWith("/v1/agent-events")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/agent-events`;
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

function sanitizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "agent";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function containsRelativeImports(source: string): boolean {
  return /\bfrom\s+["']\.\.?\//.test(source) || /\bimport\s*\(\s*["']\.\.?\//.test(source);
}

function readPropertyName(node: ts.ObjectLiteralElementLike): string | null {
  const ts = getTypeScript();
  if (!("name" in node) || !node.name) {
    return null;
  }
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function literalString(node: ts.Expression): string | null {
  const ts = getTypeScript();
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function literalStringList(node: ts.Expression): string[] | null {
  const ts = getTypeScript();
  if (ts.isArrayLiteralExpression(node)) {
    const values: string[] = [];
    for (const element of node.elements) {
      const value = literalString(element as ts.Expression);
      if (!value) return null;
      values.push(value);
    }
    return values;
  }

  const single = literalString(node);
  return single ? [single] : null;
}

function parseScheduleLiteral(node: ts.Expression): unknown[] {
  const ts = getTypeScript();
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => parseScheduleLiteral(element as ts.Expression)[0]);
  }
  const stringLiteral = literalString(node);
  if (stringLiteral) {
    return [stringLiteral];
  }
  if (ts.isObjectLiteralExpression(node)) {
    const record: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = readPropertyName(property);
      if (!key) continue;
      record[key] = literalString(property.initializer) ?? property.initializer.getText();
    }
    return [record];
  }
  return [node.getText()];
}

function findAgentObjectLiteral(source: string): {
  sourceFile: ts.SourceFile;
  objectLiteral: ts.ObjectLiteralExpression;
} {
  const ts = getTypeScript();
  const sourceFile = ts.createSourceFile("agent.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.ObjectLiteralExpression | null = null;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "agent") {
      const [firstArgument] = node.arguments;
      if (firstArgument && ts.isObjectLiteralExpression(firstArgument)) {
        found = firstArgument;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!found) {
    throw new Error("Entrypoint must call agent({...}) at the top level");
  }

  return { sourceFile, objectLiteral: found };
}

function extractManifest(source: string): AgentTriggerManifest {
  const ts = getTypeScript();
  const { objectLiteral } = findAgentObjectLiteral(source);
  let workspaceLiteral: string | null = null;
  let agentNameLiteral: string | null = null;
  let schedule: unknown[] = [];
  let watch: string[] = [];
  let inbox: string[] = [];

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = readPropertyName(property);
    if (!key) continue;

    if (key === "workspace") {
      workspaceLiteral = literalString(property.initializer);
    } else if (key === "name") {
      agentNameLiteral = literalString(property.initializer);
    } else if (key === "schedule") {
      schedule = parseScheduleLiteral(property.initializer);
    } else if (key === "watch") {
      watch = literalStringList(property.initializer) ?? [];
    } else if (key === "inbox") {
      inbox = literalStringList(property.initializer) ?? [];
    }
  }

  return { workspaceLiteral, agentNameLiteral, schedule, watch, inbox };
}

function upsertProperty(
  source: string,
  objectLiteral: ts.ObjectLiteralExpression,
  key: string,
  valueSource: string,
): string {
  const ts = getTypeScript();
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) || readPropertyName(property) !== key) {
      continue;
    }
    return `${source.slice(0, property.initializer.getStart())}${valueSource}${source.slice(property.initializer.getEnd())}`;
  }

  const insertAt = objectLiteral.getStart() + 1;
  const prefix = objectLiteral.properties.length > 0 ? "\n  " : "";
  const suffix = objectLiteral.properties.length > 0 ? "," : "";
  return `${source.slice(0, insertAt)}${prefix}${key}: ${valueSource}${suffix}${source.slice(insertAt)}`;
}

function rewriteEntrypointSource(
  source: string,
  relayWorkspaceId: string,
  deploymentName: string,
): string {
  const { objectLiteral } = findAgentObjectLiteral(source);
  let rewritten = upsertProperty(source, objectLiteral, "workspace", JSON.stringify(relayWorkspaceId));
  const refreshed = findAgentObjectLiteral(rewritten);
  rewritten = upsertProperty(rewritten, refreshed.objectLiteral, "name", JSON.stringify(deploymentName));
  return rewritten;
}

function buildHostedCustomSource(input: HostedDeployInput, relayWorkspaceId: string): string {
  const onEventSource = typeof input.runtime.onEventSource === "string"
    ? input.runtime.onEventSource.trim()
    : "";
  if (!onEventSource) {
    throw new Error("Hosted custom deployments require runtime.onEventSource");
  }

  const properties = [
    `workspace: ${JSON.stringify(relayWorkspaceId)}`,
    `name: ${JSON.stringify(input.name)}`,
    input.schedule !== undefined ? `schedule: ${JSON.stringify(input.schedule)}` : null,
    input.watch !== undefined ? `watch: ${JSON.stringify(input.watch)}` : null,
    input.inbox !== undefined ? `inbox: ${JSON.stringify(input.inbox)}` : null,
    `onEvent: ${onEventSource}`,
  ].filter(Boolean);

  return [
    `import { agent } from "@agent-relay/agent";`,
    ``,
    `await agent({`,
    ...properties.map((line) => `  ${line},`),
    `});`,
    ``,
  ].join("\n");
}

function buildHostedDefaultSource(input: HostedDeployInput, relayWorkspaceId: string): string {
  return [
    `import { agent } from "@agent-relay/agent";`,
    ``,
    `const MODEL = ${JSON.stringify(input.model)};`,
    `const INSTRUCTIONS = ${JSON.stringify(input.instructions)};`,
    ``,
    `function inferProvider(model) {`,
    `  const normalized = model.trim().toLowerCase();`,
    `  if (normalized.startsWith("openrouter/")) return "openrouter";`,
    `  if (normalized.startsWith("claude") || normalized.startsWith("anthropic/")) return "anthropic";`,
    `  if (normalized.startsWith("gemini") || normalized.startsWith("google/")) return "google";`,
    `  return "openai";`,
    `}`,
    ``,
    `function eventPrompt(event) {`,
    `  return JSON.stringify({`,
    `    instructions: INSTRUCTIONS,`,
    `    event,`,
    `  }, null, 2);`,
    `}`,
    ``,
    `function coerceText(value) {`,
    `  if (typeof value === "string") return value;`,
    `  if (Array.isArray(value)) {`,
    `    return value`,
    `      .map((entry) => {`,
    `        if (typeof entry === "string") return entry;`,
    `        if (entry && typeof entry === "object" && typeof entry.text === "string") return entry.text;`,
    `        return "";`,
    `      })`,
    `      .filter(Boolean)`,
    `      .join("\\n");`,
    `  }`,
    `  return "";`,
    `}`,
    ``,
    `async function invokeModel(fetchImpl, prompt) {`,
    `  const provider = inferProvider(MODEL);`,
    `  if (provider === "anthropic") {`,
    `    const response = await fetchImpl(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages", {`,
    `      method: "POST",`,
    `      headers: {`,
    `        "content-type": "application/json",`,
    `        "x-api-key": process.env.ANTHROPIC_API_KEY || "",`,
    `        "anthropic-version": "2023-06-01",`,
    `      },`,
    `      body: JSON.stringify({`,
    `        model: MODEL,`,
    `        system: INSTRUCTIONS,`,
    `        max_tokens: 1024,`,
    `        messages: [{ role: "user", content: prompt }],`,
    `      }),`,
    `    });`,
    `    const payload = await response.json();`,
    `    if (!response.ok) throw new Error(JSON.stringify(payload));`,
    `    return coerceText(payload.content);`,
    `  }`,
    ``,
    `  if (provider === "openrouter") {`,
    `    const response = await fetchImpl(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "https://openrouter.ai/api/v1/chat/completions", {`,
    `      method: "POST",`,
    `      headers: {`,
    `        "content-type": "application/json",`,
    `        authorization: "Bearer " + (process.env.OPENROUTER_API_KEY || ""),`,
    `      },`,
    `      body: JSON.stringify({`,
    `        model: MODEL,`,
    `        messages: [`,
    `          { role: "system", content: INSTRUCTIONS },`,
    `          { role: "user", content: prompt },`,
    `        ],`,
    `      }),`,
    `    });`,
    `    const payload = await response.json();`,
    `    if (!response.ok) throw new Error(JSON.stringify(payload));`,
    `    return coerceText(payload.choices?.[0]?.message?.content);`,
    `  }`,
    ``,
    `  const response = await fetchImpl(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "https://api.openai.com/v1/responses", {`,
    `    method: "POST",`,
    `    headers: {`,
    `      "content-type": "application/json",`,
    `      authorization: "Bearer " + (process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || ""),`,
    `    },`,
    `    body: JSON.stringify({`,
    `      model: MODEL,`,
    `      input: [`,
    `        { role: "system", content: INSTRUCTIONS },`,
    `        { role: "user", content: prompt },`,
    `      ],`,
    `    }),`,
    `  });`,
    `  const payload = await response.json();`,
    `  if (!response.ok) throw new Error(JSON.stringify(payload));`,
    `  return payload.output_text || coerceText(payload.output?.[0]?.content);`,
    `}`,
    ``,
    `await agent({`,
    `  workspace: ${JSON.stringify(relayWorkspaceId)},`,
    `  name: ${JSON.stringify(input.name)},`,
    input.schedule !== undefined ? `  schedule: ${JSON.stringify(input.schedule)},` : null,
    input.watch !== undefined ? `  watch: ${JSON.stringify(input.watch)},` : null,
    input.inbox !== undefined ? `  inbox: ${JSON.stringify(input.inbox)},` : null,
    `  onEvent: async (ctx, event) => {`,
    `    const prompt = eventPrompt(event);`,
    `    const text = String(await invokeModel(ctx.tagged(globalThis.fetch), prompt) || "").trim();`,
    `    if (!text) return;`,
    `    if (event.type === "relaycast.message") {`,
    `      if (typeof event.threadId === "string" && event.threadId) {`,
    `        await ctx.messages.reply(event.threadId, text);`,
    `        return;`,
    `      }`,
    `      if (typeof event.channel === "string" && event.channel) {`,
    `        await ctx.messages.post(event.channel, text);`,
    `        return;`,
    `      }`,
    `    }`,
    `    await ctx.files.write(\`/_agents/output/\${event.id}.md\`, {`,
    `      eventType: event.type,`,
    `      model: MODEL,`,
    `      text,`,
    `      generatedAt: new Date().toISOString(),`,
    `    });`,
    `  },`,
    `});`,
    ``,
  ].filter(Boolean).join("\n");
}

async function bundleSource(entrypoint: string, source: string): Promise<{ code: string; bundleHash: string }> {
  if (containsRelativeImports(source)) {
    throw new Error("Managed deploy currently supports single-file entrypoints only; relative imports are not supported yet");
  }

  const { build } = await loadEsbuild();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "proactive-agent-"));
  try {
    const entryPath = path.join(tempRoot, entrypoint.replace(/^\/+/, ""));
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(entryPath, source, "utf8");
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      sourcemap: "inline",
      absWorkingDir: process.cwd(),
      nodePaths: [path.join(process.cwd(), "node_modules")],
      logLevel: "silent",
    });

    const output = result.outputFiles?.[0]?.text;
    if (!output) {
      throw new Error("Bundler produced no output");
    }

    return {
      code: output,
      bundleHash: sha256(output),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function loadEsbuild(): Promise<EsbuildModule> {
  const dynamicImport = new Function(
    "specifier",
    "return import(specifier)",
  ) as (specifier: string) => Promise<EsbuildModule>;
  try {
    return await dynamicImport("esbuild");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING"
    ) {
      return await import(/* webpackIgnore: true */ "esbuild");
    }
    throw error;
  }
}

function buildSupervisorSource(input: {
  agentId: string;
  deploymentId: string;
  bundlePath: string;
  workdir: string;
  statusPath: string;
  logPath: string;
}): string {
  return `
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const agentId = ${JSON.stringify(input.agentId)};
const deploymentId = ${JSON.stringify(input.deploymentId)};
const bundlePath = ${JSON.stringify(input.bundlePath)};
const workdir = ${JSON.stringify(input.workdir)};
const statusPath = ${JSON.stringify(input.statusPath)};
const logPath = ${JSON.stringify(input.logPath)};
const backoffSchedule = [1000, 5000, 30000, 300000];

let stopping = false;
let restarts = 0;
let child = null;

function writeStatus(patch) {
  mkdirSync(dirname(statusPath), { recursive: true });
  const payload = {
    agentId,
    deploymentId,
    restarts,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  writeFileSync(statusPath, JSON.stringify(payload, null, 2), "utf8");
}

function launch() {
  const fd = openSync(logPath, "a");
  child = spawn(process.execPath, [bundlePath], {
    cwd: workdir,
    env: process.env,
    stdio: ["ignore", fd, fd],
  });

  writeStatus({ state: "running", childPid: child.pid ?? null });
  child.on("exit", (code, signal) => {
    if (stopping) {
      writeStatus({ state: "stopped", childPid: null, lastExitCode: code ?? null, lastExitSignal: signal ?? null });
      return;
    }

    restarts += 1;
    writeStatus({
      state: "restarting",
      childPid: null,
      lastExitCode: code ?? null,
      lastExitSignal: signal ?? null,
    });
    const delay = backoffSchedule[Math.min(restarts - 1, backoffSchedule.length - 1)];
    setTimeout(() => launch(), delay);
  });
}

process.on("SIGTERM", () => {
  stopping = true;
  if (child) {
    child.kill("SIGTERM");
  } else {
    writeStatus({ state: "stopped", childPid: null });
    process.exit(0);
  }
});

process.on("SIGINT", () => {
  stopping = true;
  if (child) {
    child.kill("SIGINT");
  } else {
    writeStatus({ state: "stopped", childPid: null });
    process.exit(0);
  }
});

writeStatus({ state: "starting", childPid: null });
launch();
`;
}

async function launchSandbox(input: {
  relayWorkspaceId: string;
  workspaceToken: string;
  agentId: string;
  deploymentId: string;
  bundleCode: string;
  extraEnvVars?: Record<string, string>;
}): Promise<{
  sandboxId: string;
  workdir: string;
  bundlePath: string;
  supervisorPath: string;
  statusPath: string;
  logPath: string;
}> {
  const daytona = new Daytona(resolveDaytonaSdkConfig());
  const snapshot = await getSnapshotName();
  const sandbox = await daytona.create({
    snapshot,
    language: "typescript",
    name: `agent-${input.agentId}`,
    envVars: {
      RELAY_API_KEY: input.workspaceToken,
      RELAY_AGENT_EVENTS_URL: normalizeGatewayEventsUrl(),
      NODE_ENV: "production",
      ...(input.extraEnvVars ?? {}),
    },
  });

  const workdir = `${WORKDIR_ROOT}/${input.agentId}`;
  const bundlePath = `${workdir}/${BUNDLE_FILENAME}`;
  const supervisorPath = `${workdir}/${SUPERVISOR_FILENAME}`;
  const statusPath = `${workdir}/${STATUS_FILENAME}`;
  const logPath = `${workdir}/${LOG_FILENAME}`;

  await sandbox.process.executeCommand(`mkdir -p ${JSON.stringify(workdir)}`);
  await sandbox.fs.uploadFile(Buffer.from(input.bundleCode, "utf8"), bundlePath);
  await sandbox.fs.uploadFile(
    Buffer.from(buildSupervisorSource({
      agentId: input.agentId,
      deploymentId: input.deploymentId,
      bundlePath,
      workdir,
      statusPath,
      logPath,
    }), "utf8"),
    supervisorPath,
  );
  await sandbox.process.executeCommand(
    `cd ${JSON.stringify(workdir)} && nohup node ${SUPERVISOR_FILENAME} >> ${JSON.stringify(logPath)} 2>&1 < /dev/null &`,
  );

  return {
    sandboxId: sandbox.id,
    workdir,
    bundlePath,
    supervisorPath,
    statusPath,
    logPath,
  };
}

async function destroySandbox(sandboxId: string): Promise<void> {
  const daytona = new Daytona(resolveDaytonaSdkConfig());
  const sandbox = await daytona.get(sandboxId).catch(() => null);
  if (!sandbox) {
    return;
  }
  const client = daytona as unknown as {
    delete: (sandbox: unknown) => Promise<void>;
    remove?: (sandbox: unknown) => Promise<void>;
  };
  await (client.remove ?? client.delete).call(daytona, sandbox);
}

async function readRuntimeStatus(record: ProactiveDeploymentRecord): Promise<RuntimeStatusPayload | null> {
  const daytona = new Daytona(resolveDaytonaSdkConfig());
  const sandbox = await daytona.get(record.sandboxId).catch(() => null);
  if (!sandbox) {
    return null;
  }
  const buffer = await sandbox.fs.downloadFile(record.runtime.statusPath).catch(() => null);
  if (!buffer) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(buffer).toString("utf8")) as RuntimeStatusPayload;
  } catch {
    return null;
  }
}

async function upsertSandboxRow(record: ProactiveDeploymentRecord): Promise<void> {
  if (!record.appWorkspaceId || !record.organizationId) {
    return;
  }

  const db = getDb();
  const [existing] = await db
    .select({ id: sandboxes.id })
    .from(sandboxes)
    .where(eq(sandboxes.id, record.sandboxId))
    .limit(1);

  const payload = {
    id: record.sandboxId,
    userId: record.userId,
    organizationId: record.organizationId,
    workspaceId: record.appWorkspaceId,
    source: "agent-deploy",
    status: record.status === "deleted" ? "deleted" : "running",
    updatedAt: new Date(record.updatedAt),
    createdAt: new Date(record.createdAt),
  };

  if (existing) {
    await db.update(sandboxes).set(payload).where(eq(sandboxes.id, record.sandboxId));
    return;
  }

  await db.insert(sandboxes).values(payload);
}

async function markSandboxDeleted(record: ProactiveDeploymentRecord): Promise<void> {
  if (!record.appWorkspaceId) {
    return;
  }

  await getDb()
    .update(sandboxes)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(and(eq(sandboxes.id, record.sandboxId), eq(sandboxes.workspaceId, record.appWorkspaceId)));
}

async function resolveDeployWorkspace(context: ProactiveDeployContext): Promise<{
  relayWorkspaceId: string;
  workspaceToken: string;
  appWorkspaceId: string | null;
  organizationId: string | null;
}> {
  if (context.source === "relay-workspace-token") {
    return {
      relayWorkspaceId: context.relayWorkspaceId,
      workspaceToken: context.workspaceToken,
      appWorkspaceId: context.appWorkspaceId,
      organizationId: context.organizationId,
    };
  }

  if (!context.appWorkspaceId) {
    throw new Error("Session deploys require an app workspace");
  }

  const resolved = await resolveOrProvisionRelayWorkspace({
    userId: context.userId,
    appWorkspaceId: context.appWorkspaceId,
    name: context.appWorkspaceId,
  });

  return {
    relayWorkspaceId: resolved.id,
    workspaceToken: resolved.relaycastApiKey,
    appWorkspaceId: context.appWorkspaceId,
    organizationId: context.organizationId,
  };
}

function toAgentSummary(record: ProactiveDeploymentRecord): Record<string, unknown> {
  return {
    id: record.agentId,
    agentId: record.agentId,
    name: record.name,
    displayName: record.name,
    harness: "relay-agent",
    status: record.status,
    defaultModel: record.hosted?.model,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deploymentId: record.deploymentId,
    workspaceId: record.relayWorkspaceId,
    sandboxId: record.sandboxId,
    entrypoint: record.entrypoint,
  };
}

async function createDeploymentRecord(
  context: ProactiveDeployContext,
  input: DeploySourceInput,
): Promise<ProactiveDeploymentRecord> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const manifest = extractManifest(input.source);
  const deploymentName = input.name?.trim()
    || manifest.agentNameLiteral?.trim()
    || path.basename(input.entrypoint, path.extname(input.entrypoint))
    || "agent";
  const agentId = sanitizeAgentId(deploymentName);
  const rewrittenSource = rewriteEntrypointSource(
    input.source,
    resolvedWorkspace.relayWorkspaceId,
    deploymentName,
  );
  const bundled = await bundleSource(input.entrypoint, rewrittenSource);
  const deploymentId = randomUUID();
  const extraEnvVars = input.hosted
    ? await resolveHostedProviderEnvironment({
        relayWorkspaceId: resolvedWorkspace.relayWorkspaceId,
        model: input.hosted.model,
        provider: input.hosted.provider,
        managedResolutionSource: "web-deploy-manager",
        deploymentId,
        agentId,
      })
    : {};
  const launched = await launchSandbox({
    relayWorkspaceId: resolvedWorkspace.relayWorkspaceId,
    workspaceToken: resolvedWorkspace.workspaceToken,
    agentId,
    deploymentId,
    bundleCode: bundled.code,
    extraEnvVars,
  });

  const now = new Date().toISOString();
  return {
    agentId,
    deploymentId,
    relayWorkspaceId: resolvedWorkspace.relayWorkspaceId,
    appWorkspaceId: resolvedWorkspace.appWorkspaceId,
    organizationId: resolvedWorkspace.organizationId,
    userId: context.userId,
    name: deploymentName,
    entrypoint: input.entrypoint,
    sourceText: input.source,
    sourceKind: input.sourceKind ?? "entrypoint",
    sourceHash: sha256(rewrittenSource),
    bundleHash: bundled.bundleHash,
    sandboxId: launched.sandboxId,
    status: "running",
    lastError: null,
    deployedAt: now,
    stoppedAt: null,
    createdAt: now,
    updatedAt: now,
    manifest: {
      ...manifest,
      workspaceLiteral: resolvedWorkspace.relayWorkspaceId,
      agentNameLiteral: deploymentName,
    },
    hosted: input.hosted,
    runtime: {
      workdir: launched.workdir,
      bundlePath: launched.bundlePath,
      supervisorPath: launched.supervisorPath,
      statusPath: launched.statusPath,
      logPath: launched.logPath,
    },
  };
}

function buildResponse(record: ProactiveDeploymentRecord): DeployResponse {
  const response: DeployResponse = {
    deploymentId: record.deploymentId,
    agentId: record.agentId,
    workspaceId: record.relayWorkspaceId,
    status: record.status,
  };

  if (record.appWorkspaceId) {
    response.logsUrl = `/api/v1/workspaces/${record.appWorkspaceId}/logs?agentId=${encodeURIComponent(record.agentId)}`;
  }
  return response;
}

export async function deployEntrypoint(
  context: ProactiveDeployContext,
  input: DeploySourceInput,
): Promise<DeployResponse> {
  const record = await createDeploymentRecord(context, input);
  await writeDeploymentRecord(record);
  await upsertSandboxRow(record);
  return buildResponse(record);
}

export async function deployHostedAgent(
  context: ProactiveDeployContext,
  input: HostedDeployInput,
): Promise<DeployResponse> {
  const runtimeMode = typeof input.runtime.mode === "string" ? input.runtime.mode : "";

  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const source = runtimeMode === "custom"
    ? buildHostedCustomSource(input, resolvedWorkspace.relayWorkspaceId)
    : buildHostedDefaultSource(input, resolvedWorkspace.relayWorkspaceId);
  return deployEntrypoint(context, {
    entrypoint: runtimeMode === "custom" ? "hosted-agent.ts" : "hosted-default-agent.ts",
    source,
    name: input.name,
    sourceKind: runtimeMode === "custom" ? "hosted-custom" : "hosted-default",
    hosted: {
      model: input.model,
      instructions: input.instructions,
      provider: input.provider,
    },
  });
}

export async function listDeployedAgents(
  context: ProactiveDeployContext,
): Promise<Array<Record<string, unknown>>> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const records = await listDeploymentRecords(resolvedWorkspace.relayWorkspaceId);
  return records.filter((record) => record.status !== "deleted").map(toAgentSummary);
}

export async function inspectDeployedAgent(
  context: ProactiveDeployContext,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const record = await readDeploymentRecord(resolvedWorkspace.relayWorkspaceId, agentId);
  if (!record || record.status === "deleted") {
    return null;
  }

  const runtimeStatus = await readRuntimeStatus(record);
  if (runtimeStatus?.state && runtimeStatus.state !== record.status) {
    record.status =
      runtimeStatus.state === "running"
        ? "running"
        : runtimeStatus.state === "stopped"
          ? "degraded"
          : runtimeStatus.state === "restarting"
            ? "degraded"
            : record.status;
    record.updatedAt = new Date().toISOString();
    await writeDeploymentRecord(record);
    await upsertSandboxRow(record);
  }

  return {
    ...toAgentSummary(record),
    runtimeStatus,
    manifest: record.manifest,
  };
}

export async function inspectDeploymentById(
  context: ProactiveDeployContext,
  deploymentId: string,
): Promise<Record<string, unknown> | null> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const records = await listDeploymentRecords(resolvedWorkspace.relayWorkspaceId);
  const record = records.find((entry) => entry.deploymentId === deploymentId && entry.status !== "deleted");
  if (!record) {
    return null;
  }

  const status = await inspectDeployedAgent(context, record.agentId);
  if (!status) {
    return null;
  }

  return {
    deployId: record.deploymentId,
    deploymentId: record.deploymentId,
    agentId: record.agentId,
    state: (status.status as string | undefined) ?? record.status,
    ...status,
  };
}

export async function undeployAgent(
  context: ProactiveDeployContext,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const record = await readDeploymentRecord(resolvedWorkspace.relayWorkspaceId, agentId);
  if (!record) {
    return null;
  }

  await destroySandbox(record.sandboxId).catch((error) => {
    record.lastError = error instanceof Error ? error.message : String(error);
  });

  record.status = "deleted";
  record.stoppedAt = new Date().toISOString();
  record.updatedAt = record.stoppedAt;
  await writeDeploymentRecord(record);
  await markSandboxDeleted(record);
  await deleteDeploymentRecord(record.relayWorkspaceId, record.agentId);

  return toAgentSummary(record);
}

export async function undeployDeploymentById(
  context: ProactiveDeployContext,
  deploymentId: string,
): Promise<Record<string, unknown> | null> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const records = await listDeploymentRecords(resolvedWorkspace.relayWorkspaceId);
  const record = records.find((entry) => entry.deploymentId === deploymentId && entry.status !== "deleted");
  if (!record) {
    return null;
  }
  return undeployAgent(context, record.agentId);
}

export async function redeployAgent(
  context: ProactiveDeployContext,
  agentId: string,
): Promise<DeployResponse | null> {
  const resolvedWorkspace = await resolveDeployWorkspace(context);
  const current = await readDeploymentRecord(resolvedWorkspace.relayWorkspaceId, agentId);
  if (!current) {
    return null;
  }

  await undeployAgent(context, agentId);
  return deployEntrypoint(context, {
    entrypoint: current.entrypoint,
    source: current.sourceText,
    name: current.name,
    sourceKind: current.sourceKind,
  });
}
