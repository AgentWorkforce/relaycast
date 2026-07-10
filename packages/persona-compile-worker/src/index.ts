import * as esbuild from "esbuild-wasm/lib/browser";
import wasmModule from "esbuild-wasm/esbuild.wasm";
import type { Loader, Plugin } from "esbuild-wasm/lib/browser";

const RUNNER_FORMAT_VERSION = 2;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
] as const;
const NODE_BUILTIN_EXTERNALS = [
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
] as const;
const EXTERNALS = [
  "@agentworkforce/runtime",
  "@agentworkforce/runtime/*",
  "node:*",
  ...NODE_BUILTIN_EXTERNALS,
] as const;
const CREATE_REQUIRE_BANNER = [
  'import { createRequire as __agentworkforceCreateRequire } from "node:module";',
  "const require = __agentworkforceCreateRequire(import.meta.url);",
].join("\n");

export type PersonaBundle = {
  runner: string;
  agent: string;
  packageJson: Record<string, unknown>;
};

type StagedFile = {
  path: string;
  contents?: string;
  content?: string;
};

type CompileRequest = {
  personaId?: unknown;
  entryPoint?: unknown;
  agentSource?: unknown;
  files?: unknown;
};

type VirtualFile = {
  contents: string;
  loader: Loader;
};

type CompileErrorCode =
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "compile_failed";

class CompileWorkerError extends Error {
  constructor(
    message: string,
    readonly code: CompileErrorCode,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CompileWorkerError";
  }
}

let initPromise: Promise<void> | null = null;

function ensureEsbuildInitialized() {
  initPromise ??= esbuild.initialize({
    worker: false,
    wasmModule,
  }).catch((error) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (url.pathname !== "/compile") {
      return jsonError("Not found", "not_found", 404);
    }
    if (request.method !== "POST") {
      return jsonError("Method not allowed", "method_not_allowed", 405);
    }

    try {
      await ensureEsbuildInitialized();
      const body = await readCompileRequest(request);
      const bundle = await compilePersonaBundle(body);
      return json(bundle);
    } catch (error) {
      if (error instanceof CompileWorkerError) {
        return jsonError(error.message, error.code, error.status, error.details);
      }
      const message = error instanceof Error ? error.message : String(error);
      return jsonError("Persona compile failed", "compile_failed", 500, { message });
    }
  },
};

async function readCompileRequest(request: Request): Promise<CompileRequest> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new CompileWorkerError(
      "Compile request is too large.",
      "bad_request",
      413,
      { maxBytes: MAX_REQUEST_BYTES },
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new CompileWorkerError("Compile request must be a JSON object.", "bad_request", 400);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CompileWorkerError) throw error;
    throw new CompileWorkerError("Compile request must be valid JSON.", "bad_request", 400);
  }
}

async function compilePersonaBundle(input: CompileRequest): Promise<PersonaBundle> {
  const personaId = readRequiredString(input.personaId, "personaId");
  const entryPoint = readVirtualPath(
    typeof input.entryPoint === "string" && input.entryPoint.trim()
      ? input.entryPoint
      : "agent.ts",
    "entryPoint",
  );
  const files = readVirtualFiles(input, entryPoint);
  if (!files.has(entryPoint)) {
    throw new CompileWorkerError(
      `Entry point "${entryPoint}" was not provided.`,
      "bad_request",
      400,
    );
  }

  const output = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: "inline",
    logLevel: "silent",
    minify: false,
    packages: "external",
    banner: { js: CREATE_REQUIRE_BANNER },
    resolveExtensions: [...RESOLVE_EXTENSIONS],
    external: [...EXTERNALS],
    plugins: [virtualFilesPlugin(files)],
  });

  const agent = output.outputFiles.find((file) => file.path.endsWith(".js"))?.text
    ?? output.outputFiles[0]?.text;
  if (!agent) {
    throw new CompileWorkerError(
      `esbuild produced no agent output for "${personaId}".`,
      "compile_failed",
      500,
    );
  }

  return {
    runner: renderRunner(),
    agent,
    packageJson: buildPackageJson(personaId),
  };
}

function readVirtualFiles(input: CompileRequest, entryPoint: string): Map<string, VirtualFile> {
  const files = new Map<string, VirtualFile>();
  if (typeof input.agentSource === "string") {
    files.set(entryPoint, {
      contents: input.agentSource,
      loader: loaderForPath(entryPoint),
    });
  }

  if (isRecord(input.files)) {
    for (const [filePath, contents] of Object.entries(input.files)) {
      if (typeof contents !== "string") {
        throw new CompileWorkerError(
          `File "${filePath}" contents must be a string.`,
          "bad_request",
          400,
        );
      }
      const normalized = readVirtualPath(filePath, `File "${filePath}" path`);
      files.set(normalized, { contents, loader: loaderForPath(normalized) });
    }
  } else if (Array.isArray(input.files)) {
    for (const file of input.files) {
      if (!isStagedFile(file)) {
        throw new CompileWorkerError(
          "Each staged file must include a string path and contents.",
          "bad_request",
          400,
        );
      }
      const normalized = readVirtualPath(file.path, `File "${file.path}" path`);
      files.set(normalized, {
        contents: file.contents ?? file.content ?? "",
        loader: loaderForPath(normalized),
      });
    }
  } else if (input.files !== undefined) {
    throw new CompileWorkerError(
      "files must be an object map or an array of staged files.",
      "bad_request",
      400,
    );
  }

  return files;
}

function virtualFilesPlugin(files: Map<string, VirtualFile>): Plugin {
  return {
    name: "agentworkforce-compile-worker-virtual-files",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== "entry-point" && !isRelativeSpecifier(args.path)) {
          return { path: args.path, external: true };
        }

        const resolved = args.kind === "entry-point"
          ? resolveVirtualCandidate(args.path, files)
          : resolveVirtualImport(args.path, args.importer, files);

        if (!resolved) {
          return undefined;
        }

        return { path: resolved, namespace: "agentworkforce-virtual" };
      });

      buildContext.onLoad({ filter: /.*/, namespace: "agentworkforce-virtual" }, (args) => {
        const file = files.get(args.path);
        if (!file) {
          return undefined;
        }
        return file;
      });
    },
  };
}

function resolveVirtualImport(
  specifier: string,
  importer: string,
  files: Map<string, VirtualFile>,
): string | undefined {
  const importerDir = dirnameVirtualPath(importer);
  const base = normalizeVirtualPath(`${importerDir}/${specifier}`);
  return resolveVirtualCandidate(base, files);
}

function resolveVirtualCandidate(
  specifier: string,
  files: Map<string, VirtualFile>,
): string | undefined {
  const base = normalizeVirtualPath(specifier);
  if (files.has(base)) return base;
  const extension = extensionOf(base);
  if (extension) {
    const withoutExtension = base.slice(0, -extension.length);
    for (const candidateExtension of tsSourceExtensionsForJsExtension(extension)) {
      const candidate = `${withoutExtension}${candidateExtension}`;
      if (files.has(candidate)) return candidate;
    }
    return undefined;
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (files.has(candidate)) return candidate;
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = normalizeVirtualPath(`${base}/index${extension}`);
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

function normalizeVirtualPath(value: string): string {
  const parts: string[] = [];
  for (const rawPart of value.replace(/\\/g, "/").split("/")) {
    const part = rawPart.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function readVirtualPath(value: string, field: string): string {
  const normalized = normalizeVirtualPath(value);
  if (!normalized) {
    throw new CompileWorkerError(`${field} must not be empty.`, "bad_request", 400);
  }
  if (isRootEscapingPath(value)) {
    throw new CompileWorkerError(
      `${field} must stay within the virtual source root.`,
      "bad_request",
      400,
    );
  }
  return normalized;
}

function isRootEscapingPath(value: string): boolean {
  let depth = 0;
  for (const rawPart of value.replace(/\\/g, "/").split("/")) {
    const part = rawPart.trim();
    if (!part || part === ".") continue;
    if (part === "..") {
      depth -= 1;
      if (depth < 0) return true;
    } else {
      depth += 1;
    }
  }
  return false;
}

function dirnameVirtualPath(value: string): string {
  const normalized = normalizeVirtualPath(value);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}

function extensionOf(value: string): string {
  const basename = value.slice(value.lastIndexOf("/") + 1);
  const index = basename.lastIndexOf(".");
  return index <= 0 ? "" : basename.slice(index);
}

/**
 * Map a JS-family import extension to the TypeScript source extensions that can
 * back it, following NodeNext/TS resolution rules. Returns an empty array for
 * non-JS extensions so the caller treats the specifier as unresolved.
 */
function tsSourceExtensionsForJsExtension(extension: string): string[] {
  switch (extension) {
    case ".js":
      return [".ts", ".tsx"];
    case ".mjs":
      return [".mts"];
    case ".cjs":
      return [".cts"];
    case ".jsx":
      return [".tsx"];
    default:
      return [];
  }
}

function loaderForPath(filePath: string): Loader {
  switch (extensionOf(filePath)) {
    case ".tsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    default:
      return "js";
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CompileWorkerError(`${field} is required.`, "bad_request", 400);
  }
  return value.trim();
}

function isRelativeSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStagedFile(value: unknown): value is StagedFile {
  if (!isRecord(value)) return false;
  const contents = value.contents ?? value.content;
  return typeof value.path === "string" && typeof contents === "string";
}

function buildPackageJson(personaId: string): PersonaBundle["packageJson"] {
  return {
    name: `@agentworkforce/deployed-${personaId}`,
    private: true,
    version: "0.0.0",
    type: "module",
    main: "./runner.mjs",
    dependencies: {
      "@agentworkforce/runtime": "*",
    },
    comment:
      "Generated by workforce deploy. The runtime dep is pinned to \"*\" because deploys resolve the runtime version from the active workspace.",
  };
}

function renderRunner(): string {
  return `// Generated by @agentworkforce/deploy. Format version ${RUNNER_FORMAT_VERSION}.
// Do not edit by hand - workforce deploy overwrites this file on every stage.

import { createRequire } from 'node:module';
import { startRunner } from '@agentworkforce/runtime/runner';
import { handler as wrapHandler } from '@agentworkforce/runtime';
import * as userModule from './agent.bundle.mjs';

const require = createRequire(import.meta.url);
const persona = require('./persona.json');

const exported = userModule.default ?? userModule.handler;
let candidate;
let agentSpec;
if (exported && exported.__workforceAgent) {
  candidate = exported.handler;
  agentSpec = {
    ...(exported.triggers ? { triggers: exported.triggers } : {}),
    ...(exported.schedules ? { schedules: exported.schedules } : {}),
    ...(exported.watch ? { watch: exported.watch } : {})
  };
} else if (exported && typeof exported.handler === 'function') {
  candidate = exported.handler;
  agentSpec = {
    ...(exported.triggers ? { triggers: exported.triggers } : {}),
    ...(exported.schedules ? { schedules: exported.schedules } : {}),
    ...(exported.watch ? { watch: exported.watch } : {})
  };
} else {
  candidate = exported;
}
if (typeof candidate !== 'function') {
  throw new TypeError(
    \`workforce deploy bundle: \${persona.id} did not default-export defineAgent({ ..., handler }). Did you forget export default defineAgent(...)?\`
  );
}
const handler = candidate.__workforceHandler ? candidate : wrapHandler(candidate);

const agent = readRuntimeContext('WORKFORCE_AGENT_CONTEXT');
const deployment = readRuntimeContext('WORKFORCE_DEPLOYMENT_CONTEXT');

await startRunner({ persona, agent, deployment, handler, ...(agentSpec ? { agentSpec } : {}) });

function readRuntimeContext(name) {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(\`workforce deploy bundle: missing \${name}; the deploy launcher must inject runtime row context\`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      \`workforce deploy bundle: \${name} must be valid JSON: \${err instanceof Error ? err.message : String(err)}\`
    );
  }
}
`;
}

function json(payload: unknown, init?: ResponseInit) {
  return Response.json(payload, init);
}

function jsonError(
  error: string,
  code: CompileErrorCode,
  status: number,
  details?: unknown,
) {
  return json({ error, code, ...(details === undefined ? {} : { details }) }, { status });
}
