import { parse } from "acorn";
import { simple as walkSimple } from "acorn-walk";

import type {
  PersonaInputPicker,
  PersonaInputSummary,
  PersonaIntegrationSummary,
  PersonaSummary,
  PersonaTriggerSummary,
} from "../../app/deploy/_lib/types";
import { resolveGitCloneCredentials } from "../integrations/github-clone-token";
import { getCloudflareContext } from "../cloudflare-context";
import { collectHelperScope, evaluateHelperValue, type HelperScope } from "./persona-helper-eval";

type AstNode = {
  type: string;
  [key: string]: unknown;
};

type StaticRecord = Record<string, unknown>;

type CompileWorkerBinding = {
  fetch(request: Request): Promise<Response>;
};

const walk = walkSimple as unknown as (
  node: AstNode,
  visitors: Record<string, (node: AstNode) => void>,
) => void;

const DEMO_PERSONAS: Record<string, PersonaSummary> = {
  review: {
    id: "pr-reviewer",
    name: "Review Agent",
    slug: "review",
    tagline: "Reviews every PR, fixes what's broken, merges when you approve.",
    description:
      "Reviews new PRs, fixes the issues found (its own + other bots'), resolves failing CI and merge conflicts, pings you on Slack when ready, and merges once you approve.",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: false,
    integrations: [
      {
        provider: "github",
        label: "GitHub",
        providerConfigKey: "github-relay",
        description: "Read PRs, push fixes, resolve CI + conflicts, and merge.",
      },
      {
        provider: "slack",
        label: "Slack",
        providerConfigKey: "slack-relay",
        description: "Ping you when a PR is ready for your approval.",
      },
    ],
    inputs: [
      {
        key: "SLACK_CHANNEL",
        description: "Slack channel to post review updates to.",
        optional: true,
        picker: { provider: "slack", resource: "channels" },
      },
      {
        key: "APPROVERS",
        description: "GitHub logins whose approval merges the PR. If unset, any approval merges.",
        optional: true,
        picker: { provider: "github", resource: "users" },
      },
      {
        key: "REVIEW_AUTHORS",
        description: "Only review PRs opened by these GitHub logins. If unset, every author is reviewed.",
        optional: true,
        picker: { provider: "github", resource: "users" },
      },
      {
        key: "SKIP_LABELS",
        description: 'PR labels that disable the reviewer. Defaults to "no-agent-relay-review".',
        optional: true,
      },
    ],
    triggers: [
      { kind: "integration", provider: "github", label: "A PR is opened, updated, reviewed, or CI finishes" },
    ],
  },
  granola: {
    id: "granola-prospect",
    name: "Granola Agent",
    slug: "granola",
    tagline: "Turns prospect calls into a Linear issue and an implementing PR.",
    description:
      "When a Granola recording lands, detects prospect calls, files a Linear issue with the ask, and opens a GitHub PR implementing it.",
    harness: "claude",
    model: "claude-sonnet-4-6",
    modelProvider: "anthropic",
    useSubscription: true,
    integrations: [
      {
        provider: "granola",
        label: "Granola",
        providerConfigKey: "granola-relay",
        description: "Receive new meeting recordings.",
      },
      {
        provider: "linear",
        label: "Linear",
        providerConfigKey: "linear-relay",
        description: "File an issue capturing the prospect's ask.",
      },
      {
        provider: "github",
        label: "GitHub",
        providerConfigKey: "github-relay",
        description: "Open a PR implementing the requested change.",
      },
    ],
    inputs: [],
    triggers: [
      { kind: "integration", provider: "granola", label: "A new Granola note is synced" },
    ],
  },
  linear: {
    id: "linear-chat-lead",
    name: "Linear Agent",
    slug: "linear",
    tagline: "Owns Linear agent-session chat and delegates implementation requests.",
    description:
      "Owns Linear agent-session chat, answers follow-up prompts, and delegates implementation requests to a coding workflow.",
    harness: null,
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: true,
    integrations: [
      {
        provider: "linear",
        label: "Linear",
        providerConfigKey: "linear-relay",
        description: "Listen for Linear agent-session events, mentions, and labelled issues.",
      },
    ],
    inputs: [
      {
        key: "MENTION",
        description: "Optional comma-separated Linear mention aliases.",
        optional: true,
      },
    ],
    triggers: [
      { kind: "integration", provider: "linear", label: "Linear agent-session or issue event" },
    ],
  },
  "repo-hygiene": {
    id: "repo-hygiene",
    name: "Repo Hygiene Agent",
    slug: "repo-hygiene",
    tagline: "Diagnoses code smells on every PR and journals to Notion.",
    description:
      "Diagnoses duplicated/dead code, divergent paths, stale skills/rules/docs, and code smells; comments findings and journals the run to Notion.",
    harness: "codex",
    model: "gpt-5.5",
    modelProvider: "openai",
    useSubscription: true,
    integrations: [
      {
        provider: "github",
        label: "GitHub",
        providerConfigKey: "github-relay",
        description: "Read PRs and comment hygiene findings.",
      },
      {
        provider: "notion",
        label: "Notion",
        providerConfigKey: "notion-relay",
        description: "Journal each run.",
      },
      {
        provider: "slack",
        label: "Slack",
        providerConfigKey: "slack-relay",
        description: "Post high-level hygiene updates.",
      },
    ],
    inputs: [],
    triggers: [
      { kind: "integration", provider: "github", label: "A GitHub PR is opened or updated" },
    ],
  },
  "hn-monitor": {
    id: "hn-monitor",
    name: "Hacker News Monitor",
    slug: "hn-monitor",
    tagline: "Scans HN for your topics and posts a digest to Slack.",
    description:
      "Scans Hacker News a few times a day for topics you care about and posts a summary to Slack.",
    harness: "claude",
    model: "claude-haiku-4-5-20251001",
    modelProvider: "anthropic",
    useSubscription: false,
    integrations: [
      {
        provider: "slack",
        label: "Slack",
        providerConfigKey: "slack-relay",
        description: "Post the digest to your channel.",
      },
    ],
    inputs: [
      {
        key: "TOPICS",
        description: "Comma-separated keywords to watch for.",
        optional: false,
        default: "agents,ai,typescript,developer tools",
      },
      {
        key: "SLACK_CHANNEL",
        description: "Slack channel id to post the digest to.",
        optional: false,
        picker: { provider: "slack", resource: "channels" },
      },
    ],
    triggers: [{ kind: "schedule", provider: "schedule", label: "Twice a day" }],
  },
  "spotify-releases": {
    id: "spotify-releases",
    name: "Spotify Releases",
    slug: "spotify-releases",
    tagline: "DMs you new releases from artists you follow.",
    description: "Checks for new releases from artists you follow and DMs them to you.",
    harness: null,
    useSubscription: false,
    integrations: [
      {
        provider: "slack",
        label: "Slack",
        providerConfigKey: "slack-relay",
        description: "DM you the new releases.",
      },
    ],
    inputs: [],
    triggers: [{ kind: "schedule", provider: "schedule", label: "Daily" }],
  },
  "vendor-monitor": {
    id: "vendor-monitor",
    name: "Vendor Monitor",
    slug: "vendor-monitor",
    tagline: "Watches your stack for new releases and posts changes.",
    description:
      "Watches the vendors in your stack for new releases and posts changes to your team channel.",
    harness: null,
    useSubscription: false,
    integrations: [
      {
        provider: "slack",
        label: "Slack",
        providerConfigKey: "slack-relay",
        description: "Post vendor release changes to your team channel.",
      },
    ],
    inputs: [],
    triggers: [{ kind: "schedule", provider: "schedule", label: "Weekday mornings" }],
  },
};

export type PersonaResolveInput = {
  url: string;
  auth?: PersonaResolveAuth;
};

export type PersonaResolveBundle = {
  runner: string;
  agent: string;
  packageJson: Record<string, unknown>;
  sizeBytes?: number;
};

export type PersonaResolveResponse = {
  persona: StaticRecord | null;
  agent: StaticRecord | null;
  bundle: PersonaResolveBundle | null;
  summary: PersonaSummary;
  warnings?: string[];
  fallback?: {
    reason: string;
  };
};

export type GitHubSource = {
  originalUrl: string;
  rawUrl: string;
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
};

export type PersonaResolveAuth = {
  userId: string;
  workspaceId: string;
};

type GitHubCredentials = {
  username: string;
  token: string;
};

type GitHubFetchContext = {
  auth?: PersonaResolveAuth;
  credentialsByRepo: Map<string, Promise<GitHubCredentials | null>>;
};

export type PersonaResolveSourcesInput = {
  url: string;
  personaSource: string;
  agentSource?: string;
  source?: GitHubSource;
  // Top-level `const NAME = readFileSync(new URL('./x', import.meta.url))`
  // declarations pre-resolved to their file contents. The persona authoring
  // pattern bakes a behavior spec via `default: SPEC_MD` where
  // `SPEC_MD = readFileSync(new URL('./SPEC.md', import.meta.url), 'utf-8')`;
  // the static evaluator can't run readFileSync, so the referencing field is
  // resolved from this map instead (see resolveReadFileConsts).
  fileConsts?: Record<string, string>;
};

class UnsupportedStaticValue extends Error {
  constructor(path: string, nodeType: string) {
    super(`${path} uses unsupported dynamic syntax (${nodeType})`);
  }
}

export class PersonaResolveAuthRequiredError extends Error {
  constructor(source: GitHubSource) {
    super(
      `GitHub authentication is required to resolve ${source.owner}/${source.repo}. Sign in and connect the GitHub integration for this workspace.`,
    );
    this.name = "PersonaResolveAuthRequiredError";
  }
}

export class PersonaResolveGithubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaResolveGithubAuthError";
  }
}

export async function resolvePersonaFromUrl(input: PersonaResolveInput): Promise<PersonaResolveResponse> {
  let source: GitHubSource | undefined;
  const fetchContext: GitHubFetchContext = {
    auth: input.auth,
    credentialsByRepo: new Map(),
  };

  try {
    source = githubBlobToRaw(input.url);
    const personaSource = await fetchGithubText(source, source.filePath, fetchContext);
    const fileConsts = await resolveReadFileConsts(source, personaSource, fetchContext);
    const onEvent = extractOnEvent(personaSource);
    const onEventSource = onEvent ? resolveOnEventSource(source, onEvent) : undefined;
    const agentSource = onEventSource
      ? await fetchGithubText(onEventSource, onEventSource.filePath, fetchContext)
      : undefined;
    const resolved = resolvePersonaFromSources({
      url: input.url,
      source,
      personaSource,
      agentSource,
      fileConsts,
    });

    if (resolved.fallback || !resolved.persona || !agentSource || !onEvent) {
      return resolved;
    }

    const bundleSource = onEventSource ?? source;
    return await resolveBundle({
      resolved,
      source: bundleSource,
      entryPoint: bundleSource.filePath,
      agentSource,
      fetchContext,
    });
  } catch (error) {
    if (
      error instanceof PersonaResolveAuthRequiredError ||
      error instanceof PersonaResolveGithubAuthError
    ) {
      throw error;
    }
    return fallbackResponse(input.url, source, error);
  }
}

export function resolvePersonaFromSources(input: PersonaResolveSourcesInput): PersonaResolveResponse {
  const warnings: string[] = [];
  const source = input.source ?? safeGithubBlobToRaw(input.url);

  try {
    const personaObject = parseDefineObject(input.personaSource, "definePersona", "persona.ts");
    const personaScope = collectConstScope(input.personaSource);
    mergeFileConsts(personaScope, input.fileConsts);
    const persona = staticObjectFromNode(personaObject, "persona", warnings, personaScope);
    const agent = input.agentSource
      ? extractAgentSpec(input.agentSource, warnings)
      : {};

    const summary = summarizePersona(persona, agent, source, input.url);

    return {
      persona,
      agent,
      bundle: null,
      summary,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    return fallbackResponse(input.url, source, error, warnings);
  }
}

export function githubBlobToRaw(inputUrl: string): GitHubSource {
  let parsed: URL;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error("url must be an absolute GitHub blob or raw.githubusercontent.com URL");
  }

  if (parsed.hostname === "raw.githubusercontent.com") {
    const [owner, repo, ref, ...fileParts] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo || !ref || fileParts.length === 0) {
      throw new Error("raw GitHub URL must include owner, repo, ref, and path");
    }
    return {
      originalUrl: inputUrl,
      rawUrl: parsed.toString(),
      owner,
      repo,
      ref,
      filePath: fileParts.join("/"),
    };
  }

  if (parsed.hostname !== "github.com") {
    throw new Error("url must point to github.com or raw.githubusercontent.com");
  }

  const [owner, repo, blob, ref, ...fileParts] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo || blob !== "blob" || !ref || fileParts.length === 0) {
    throw new Error("GitHub URL must look like https://github.com/<owner>/<repo>/blob/<ref>/<path>");
  }

  const filePath = fileParts.join("/");
  return {
    originalUrl: inputUrl,
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`,
    owner,
    repo,
    ref,
    filePath,
  };
}

function safeGithubBlobToRaw(inputUrl: string): GitHubSource | undefined {
  try {
    return githubBlobToRaw(inputUrl);
  } catch {
    return undefined;
  }
}

async function fetchGithubText(
  source: GitHubSource,
  remotePath: string,
  context: GitHubFetchContext,
): Promise<string> {
  const publicUrl = rawUrlForRemotePath(source, remotePath);
  const publicResponse = await fetch(publicUrl);
  if (publicResponse.ok) {
    return publicResponse.text();
  }
  if (!shouldTryAuthenticatedGithubFetch(publicResponse.status)) {
    throw new Error(`failed to fetch ${publicUrl}: ${publicResponse.status} ${publicResponse.statusText}`);
  }

  if (!context.auth) {
    throw new PersonaResolveAuthRequiredError(source);
  }

  const credentials = await resolveGithubCredentials(source, context);
  if (!credentials) {
    throw new PersonaResolveGithubAuthError(
      `No GitHub integration credential can read ${source.owner}/${source.repo}. Install or reconnect the GitHub integration for this workspace, then retry.`,
    );
  }

  const contentsUrl = githubContentsApiUrl(source, remotePath);
  const authenticatedResponse = await fetch(contentsUrl, {
    headers: {
      authorization: `token ${credentials.token}`,
      accept: "application/vnd.github.raw",
      "user-agent": "agent-relay-persona-resolve",
    },
  });
  if (!authenticatedResponse.ok) {
    throw new PersonaResolveGithubAuthError(
      `GitHub integration could not read ${source.owner}/${source.repo}/${remotePath}: ${authenticatedResponse.status} ${authenticatedResponse.statusText}`,
    );
  }
  return authenticatedResponse.text();
}

function shouldTryAuthenticatedGithubFetch(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

async function resolveGithubCredentials(
  source: GitHubSource,
  context: GitHubFetchContext,
): Promise<GitHubCredentials | null> {
  const key = `${source.owner}/${source.repo}`;
  const existing = context.credentialsByRepo.get(key);
  if (existing) return existing;

  const promise = resolveGitCloneCredentials({
    userId: context.auth!.userId,
    workspaceId: context.auth!.workspaceId,
    remoteUrl: `https://github.com/${source.owner}/${source.repo}`,
  });
  context.credentialsByRepo.set(key, promise);
  return promise;
}

function githubContentsApiUrl(source: GitHubSource, remotePath: string): string {
  const encodedPath = remotePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(
    source.repo,
  )}/contents/${encodedPath}?ref=${encodeURIComponent(source.ref)}`;
}

function resolveOnEventSource(source: GitHubSource, onEvent: string): GitHubSource {
  if (/^https?:\/\//i.test(onEvent)) {
    return githubBlobToRaw(onEvent);
  }

  const remoteDir = dirname(source.filePath);
  const resolved = normalizeRemotePath(`${remoteDir}/${onEvent}`);
  return {
    ...source,
    rawUrl: rawUrlForRemotePath(source, resolved),
    filePath: resolved,
  };
}

async function resolveBundle(input: {
  resolved: PersonaResolveResponse;
  source: GitHubSource;
  entryPoint: string;
  agentSource: string;
  fetchContext: GitHubFetchContext;
}): Promise<PersonaResolveResponse> {
  try {
    const worker = resolveCompileWorkerBinding();
    if (!worker) {
      throw new Error("PERSONA_COMPILE_WORKER binding is not available");
    }

    const entryPoint = input.entryPoint;
    const files = await collectCompileFiles({
      source: input.source,
      entryPoint,
      agentSource: input.agentSource,
      fetchContext: input.fetchContext,
    });
    const response = await worker.fetch(new Request("https://persona-compile-worker.internal/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personaId: input.resolved.persona?.id,
        entryPoint,
        files,
      }),
    }));

    if (!response.ok) {
      throw new Error(`compile worker failed: ${response.status} ${await response.text()}`);
    }

    const bundle = parseCompileWorkerBundle(await response.json());
    return {
      ...input.resolved,
      bundle,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...input.resolved,
      bundle: null,
      warnings: [...(input.resolved.warnings ?? []), reason],
      fallback: { reason },
    };
  }
}

function resolveCompileWorkerBinding(): CompileWorkerBinding | null {
  try {
    const env = getCloudflareContext({ async: false }).env;
    const candidate = env?.PERSONA_COMPILE_WORKER;
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as CompileWorkerBinding).fetch === "function"
    ) {
      return candidate as CompileWorkerBinding;
    }
  } catch {
    return null;
  }
  return null;
}

async function collectCompileFiles(input: {
  source: GitHubSource;
  entryPoint: string;
  agentSource: string;
  fetchContext: GitHubFetchContext;
}): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    [input.entryPoint]: input.agentSource,
  };
  const queue = [{ path: input.entryPoint, source: input.agentSource }];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const specifier of extractRelativeImportSpecifiers(current.source)) {
      const resolvedPath = await resolveRemoteImportPath(
        input.source,
        current.path,
        specifier,
        files,
        input.fetchContext,
      );
      if (!resolvedPath) {
        continue;
      }
      const source = await fetchGithubText(input.source, resolvedPath, input.fetchContext);
      files[resolvedPath] = source;
      queue.push({ path: resolvedPath, source });
    }
  }

  return files;
}

function extractRelativeImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const importExportPattern = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?["'](\.{1,2}\/[^"']+)["']/g;
  const dynamicImportPattern = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  const requirePattern = /\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const pattern of [importExportPattern, dynamicImportPattern, requirePattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      specifiers.add(match[1]!);
    }
  }
  return [...specifiers];
}

async function resolveRemoteImportPath(
  source: GitHubSource,
  importerPath: string,
  specifier: string,
  knownFiles: Record<string, string>,
  fetchContext: GitHubFetchContext,
): Promise<string | undefined> {
  const base = normalizeRemotePath(`${dirname(importerPath)}/${specifier}`);
  const candidates = importCandidates(base);
  for (const candidate of candidates) {
    if (knownFiles[candidate] !== undefined) {
      return undefined;
    }
    try {
      await fetchGithubText(source, candidate, fetchContext);
      return candidate;
    } catch {
      // Try the next extension/index candidate.
    }
  }
  return undefined;
}

function importCandidates(base: string): string[] {
  const extension = extensionOf(base);
  if (extension) {
    const tsCandidates = tsSourceExtensionsForJsExtension(extension);
    if (tsCandidates.length > 0) {
      const withoutExtension = base.slice(0, -extension.length);
      return [base, ...tsCandidates.map((ext) => `${withoutExtension}${ext}`)];
    }
    return [base];
  }
  const extensions = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json"];
  return [
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => normalizeRemotePath(`${base}/index${extension}`)),
  ];
}

/**
 * Map a JS-family import extension to the TypeScript source extensions that can
 * back it, following NodeNext/TS resolution rules. Returns an empty array for
 * non-JS extensions (e.g. .json) so the caller keeps the literal specifier.
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

function rawUrlForRemotePath(source: GitHubSource, remotePath: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${remotePath}`;
}

function extensionOf(filePath: string): string {
  const name = basename(filePath);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

function parseCompileWorkerBundle(value: unknown): PersonaResolveBundle {
  const record = objectValue(value);
  if (
    !record ||
    typeof record.runner !== "string" ||
    typeof record.agent !== "string" ||
    !objectValue(record.packageJson)
  ) {
    throw new Error("compile worker returned an invalid bundle payload");
  }
  return {
    runner: record.runner,
    agent: record.agent,
    packageJson: record.packageJson as Record<string, unknown>,
  };
}

function extractOnEvent(personaSource: string): string | undefined {
  const object = parseDefineObject(personaSource, "definePersona", "persona.ts");
  const property = propertyMap(object).get("onEvent");
  if (!property) {
    return undefined;
  }
  const value = staticValueFromNode(property, "persona.onEvent", [], collectConstScope(personaSource));
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractAgentSpec(agentSource: string, warnings: string[]): StaticRecord {
  const agentObject = parseDefineObject(agentSource, "defineAgent", "agent.ts", {
    replaceTopLevelProperties: { handler: "null" },
  });
  const properties = propertyMap(agentObject);
  const agent: StaticRecord = {};
  const scope = collectConstScope(agentSource);
  // Helper-function scope for triggers/schedules built by a local pure helper
  // (e.g. `schedules: [weekdaysAt('morning', '09:00')]`) — the literal evaluator
  // can't run the call, but evaluateHelperValue can. Collected lazily (only when
  // a static eval fails) to avoid the parse cost for purely literal specs.
  let helperScope: HelperScope | undefined;
  const getHelperScope = () => (helperScope ??= collectHelperScope(agentSource));
  const triggers = properties.get("triggers");
  const schedules = properties.get("schedules");

  if (triggers) {
    const resolved = resolveAgentMetaValue(triggers, "agent.triggers", warnings, scope, getHelperScope);
    if (resolved !== undefined) agent.triggers = resolved;
  }
  if (schedules) {
    const resolved = resolveAgentMetaValue(schedules, "agent.schedules", warnings, scope, getHelperScope);
    if (resolved !== undefined) agent.schedules = resolved;
  }

  return agent;
}

// Resolve an agent trigger/schedule property. Literal specs go through the
// static evaluator; specs built by a local pure helper (cron schedules, most
// importantly) fall back to the bounded helper interpreter. If neither resolves
// it, record a warning and return undefined so the REST of the persona still
// resolves (no demo-data fallback) — the deploy registers whatever schedules did
// resolve. Scheduled personas rely on the interpreter succeeding; the warning
// surfaces the cases it still can't reach.
function resolveAgentMetaValue(
  node: AstNode,
  path: string,
  warnings: string[],
  scope: ConstScope,
  getHelperScope: () => HelperScope,
): unknown {
  try {
    return staticValueFromNode(node, path, warnings, scope);
  } catch (staticError) {
    try {
      return evaluateHelperValue(node, getHelperScope(), path);
    } catch (helperError) {
      const reason = helperError instanceof Error
        ? helperError.message
        : staticError instanceof Error
          ? staticError.message
          : String(helperError);
      warnings.push(reason);
      return undefined;
    }
  }
}

function parseDefineObject(
  source: string,
  callee: string,
  label: string,
  options?: { replaceTopLevelProperties?: Record<string, string> },
): AstNode {
  let objectSource = extractCallObjectSource(source, callee);
  if (!objectSource) {
    throw new Error(`${label} must default-export ${callee}({ ... })`);
  }

  for (const [property, replacement] of Object.entries(options?.replaceTopLevelProperties ?? {})) {
    objectSource = replaceTopLevelPropertyValue(objectSource, property, replacement);
  }

  return parseObjectExpression(objectSource, label);
}

function parseObjectExpression(objectSource: string, label: string): AstNode {
  const wrapped = `const __agentworkforceValue = ${objectSource};`;
  const ast = parse(wrapped, {
    ecmaVersion: 2024,
    sourceType: "module",
    allowHashBang: true,
  }) as unknown as AstNode;
  let found: AstNode | undefined;

  walk(ast, {
    VariableDeclarator(node) {
      const id = node.id as AstNode | undefined;
      const init = node.init as AstNode | undefined;
      if (id?.type === "Identifier" && id.name === "__agentworkforceValue" && init?.type === "ObjectExpression") {
        found = init;
      }
    },
  });

  if (!found) {
    throw new Error(`${label} must pass an object literal to definePersona/defineAgent`);
  }
  return found;
}

type ConstScope = Map<string, AstNode>;

const EMPTY_SCOPE: ConstScope = new Map();

// Matches a top-level `const NAME = readFileSync(new URL('./rel', import.meta.url) ...)`
// declaration (optionally `export`ed, optionally type-annotated, optionally an
// `fs.`/`nodeFs.` member call). Captures the binding name and the relative path
// of the sibling file. This is the canonical persona pattern for baking a
// behavior spec into an input default — see resolveReadFileConsts.
const READ_FILE_CONST_PATTERN =
  /(?:^|[;{}\n])\s*(?:export\s+)?const\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*(?::[^=]+)?=\s*(?:[$_\p{ID_Start}][$_\p{ID_Continue}]*\.)?readFileSync\(\s*new\s+URL\(\s*(['"`])(\.{1,2}\/[^'"`]+)\2\s*,\s*import\.meta\.url\s*\)/gu;

type ReadFileConst = { name: string; relativePath: string };

function extractReadFileConsts(source: string): ReadFileConst[] {
  const out: ReadFileConst[] = [];
  READ_FILE_CONST_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = READ_FILE_CONST_PATTERN.exec(source)) !== null) {
    out.push({ name: match[1]!, relativePath: match[3]! });
  }
  return out;
}

// Persona authors bake a compiled-in behavior spec with
//   const SPEC_MD = readFileSync(new URL('./SPEC.md', import.meta.url), 'utf-8');
//   ... inputs: { SPEC: { default: SPEC_MD } }
// The static evaluator can't execute readFileSync, so without this the whole
// persona resolve aborts to demo data (issue #17). We fetch each referenced
// sibling file from the same GitHub source and return name -> contents, which is
// merged into the const scope as a string literal before static evaluation.
// A file that can't be fetched is left unresolved; the referencing field then
// falls back naturally rather than aborting the resolve.
async function resolveReadFileConsts(
  source: GitHubSource,
  personaSource: string,
  fetchContext: GitHubFetchContext,
): Promise<Record<string, string>> {
  const declarations = extractReadFileConsts(personaSource);
  if (declarations.length === 0) {
    return {};
  }
  const baseDir = dirname(source.filePath);
  const resolved: Record<string, string> = {};
  // Fetch siblings concurrently — they're independent round-trips, and the
  // writes target distinct keys so they don't race.
  await Promise.all(
    declarations.map(async ({ name, relativePath }) => {
      try {
        const remotePath = normalizeRemotePath(`${baseDir}/${relativePath}`);
        resolved[name] = await fetchGithubText(source, remotePath, fetchContext);
      } catch {
        // Sibling file missing/unreadable — leave the const unresolved.
      }
    }),
  );
  return resolved;
}

function mergeFileConsts(scope: ConstScope, fileConsts: Record<string, string> | undefined): void {
  if (!fileConsts) {
    return;
  }
  for (const [name, content] of Object.entries(fileConsts)) {
    scope.set(name, { type: "Literal", value: content });
  }
}

// Collect top-level `const <name> = { ... }` / `[ ... ]` literal declarations so
// a definePersona/defineAgent object can reference them by identifier — a common
// TypeScript authoring pattern, frequently paired with `satisfies T` / `as T`.
// Only object/array literal initializers are captured; a trailing `satisfies`/
// `as` is naturally excluded because we slice to the matching closing delimiter.
function collectConstScope(source: string): ConstScope {
  const scope: ConstScope = new Map();
  const declPattern =
    /(?:^|[;{}\n])\s*(?:export\s+)?const\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*(?::[^=]+)?=\s*/gu;
  let match: RegExpExecArray | null;
  while ((match = declPattern.exec(source)) !== null) {
    const name = match[1]!;
    const valueStart = declPattern.lastIndex;
    const opener = source[valueStart];
    if (opener !== "{" && opener !== "[") {
      continue;
    }
    const end = findMatchingDelimiter(source, valueStart);
    if (end === -1) {
      continue;
    }
    try {
      scope.set(name, parseLiteralExpression(source.slice(valueStart, end + 1), `const ${name}`));
    } catch {
      // A const we can't statically parse is simply not resolvable; skip it so
      // the referencing field falls back rather than aborting the whole parse.
    }
  }
  return scope;
}

function parseLiteralExpression(literalSource: string, label: string): AstNode {
  const wrapped = `const __agentworkforceValue = ${literalSource};`;
  const ast = parse(wrapped, {
    ecmaVersion: 2024,
    sourceType: "module",
    allowHashBang: true,
  }) as unknown as AstNode;
  let found: AstNode | undefined;

  walk(ast, {
    VariableDeclarator(node) {
      const id = node.id as AstNode | undefined;
      const init = node.init as AstNode | undefined;
      if (id?.type === "Identifier" && id.name === "__agentworkforceValue" && init) {
        found = init;
      }
    },
  });

  if (!found) {
    throw new Error(`${label} is not a static literal`);
  }
  return found;
}

// Uniform bracket matcher (string/comment aware) starting at an opening
// `{`/`[`/`(`; returns the index of the matching closer, or -1.
function findMatchingDelimiter(source: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function extractCallObjectSource(source: string, callee: string): string | undefined {
  let index = 0;
  while (index < source.length) {
    const calleeIndex = source.indexOf(callee, index);
    if (calleeIndex === -1) {
      return undefined;
    }

    const before = source[calleeIndex - 1] ?? "";
    const after = source[calleeIndex + callee.length] ?? "";
    if (isIdentifierPart(before) || isIdentifierPart(after)) {
      index = calleeIndex + callee.length;
      continue;
    }

    let cursor = skipWhitespace(source, calleeIndex + callee.length);
    if (source[cursor] === "<") {
      cursor = skipTypeParameters(source, cursor);
      cursor = skipWhitespace(source, cursor);
    }
    if (source[cursor] !== "(") {
      index = calleeIndex + callee.length;
      continue;
    }

    cursor = skipWhitespace(source, cursor + 1);
    if (source[cursor] !== "{") {
      throw new Error(`${callee} must be called with an object literal first argument`);
    }

    const end = findMatchingBrace(source, cursor);
    return source.slice(cursor, end + 1);
  }

  return undefined;
}

function replaceTopLevelPropertyValue(
  objectSource: string,
  propertyName: string,
  replacement: string,
): string {
  let cursor = 1;
  while (cursor < objectSource.length - 1) {
    cursor = skipWhitespace(objectSource, cursor);
    const parsedKey = readPropertyKey(objectSource, cursor);
    if (!parsedKey) {
      cursor += 1;
      continue;
    }

    let afterKey = skipWhitespace(objectSource, parsedKey.end);
    if (objectSource[afterKey] !== ":") {
      cursor = parsedKey.end;
      continue;
    }
    afterKey += 1;
    if (parsedKey.key !== propertyName) {
      cursor = afterKey;
      continue;
    }

    const valueEnd = findTopLevelPropertyValueEnd(objectSource, afterKey);
    return `${objectSource.slice(0, afterKey)} ${replacement}${objectSource.slice(valueEnd)}`;
  }

  return objectSource;
}

function readPropertyKey(source: string, start: number): { key: string; end: number } | undefined {
  const first = source[start];
  if (!first) {
    return undefined;
  }

  if (first === "'" || first === "\"") {
    let escaped = false;
    let key = "";
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (escaped) {
        key += char;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === first) {
        return { key, end: cursor + 1 };
      } else {
        key += char;
      }
    }
    return undefined;
  }

  if (!/[$_\p{ID_Start}]/u.test(first)) {
    return undefined;
  }
  let cursor = start + 1;
  while (cursor < source.length && isIdentifierPart(source[cursor] ?? "")) {
    cursor += 1;
  }
  return { key: source.slice(start, cursor), end: cursor };
}

function findTopLevelPropertyValueEnd(source: string, valueStart: number): number {
  let depth = 1;
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = valueStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === ")" || char === "]") {
      if (depth === 1 && char === "}") {
        return index;
      }
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 1) {
      return index;
    }
  }

  return source.length - 1;
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index;
  while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor;
}

function skipTypeParameters(source: string, index: number): number {
  let depth = 0;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === "<") {
      depth += 1;
    } else if (char === ">") {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
  }
  throw new Error("unterminated type parameter list before defineAgent object");
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error("unterminated object literal in definePersona/defineAgent call");
}

function isIdentifierPart(value: string): boolean {
  return /[$_\p{ID_Continue}]/u.test(value);
}

function propertyMap(objectNode: AstNode): Map<string, AstNode> {
  const properties = Array.isArray(objectNode.properties)
    ? objectNode.properties as AstNode[]
    : [];
  const map = new Map<string, AstNode>();

  for (const property of properties) {
    if (property.type !== "Property" && property.type !== "MethodDefinition") {
      continue;
    }
    if (property.computed === true) {
      continue;
    }
    const key = property.key as AstNode | undefined;
    const value = property.value as AstNode | undefined;
    const name = keyName(key);
    if (name && value) {
      map.set(name, value);
    }
  }

  return map;
}

function keyName(key: AstNode | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  if (key.type === "Identifier" && typeof key.name === "string") {
    return key.name;
  }
  if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  return undefined;
}

function staticObjectFromNode(
  node: AstNode,
  path: string,
  warnings: string[],
  scope: ConstScope = EMPTY_SCOPE,
): StaticRecord {
  const value = staticValueFromNode(node, path, warnings, scope);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object literal`);
  }
  return value as StaticRecord;
}

function staticValueFromNode(
  node: AstNode,
  path: string,
  warnings: string[],
  scope: ConstScope = EMPTY_SCOPE,
): unknown {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      return staticTemplateLiteral(node, path);
    case "ArrayExpression":
      return staticArray(node, path, warnings, scope);
    case "ObjectExpression":
      return staticObject(node, path, warnings, scope);
    case "UnaryExpression":
      return staticUnary(node, path, warnings, scope);
    case "Identifier": {
      if (node.name === "undefined") {
        return undefined;
      }
      const resolved = typeof node.name === "string" ? scope.get(node.name) : undefined;
      if (resolved) {
        return staticValueFromNode(resolved, path, warnings, scope);
      }
      throw new UnsupportedStaticValue(path, node.type);
    }
    case "CallExpression":
      return staticCall(node, path, warnings, scope);
    default:
      throw new UnsupportedStaticValue(path, node.type);
  }
}

function staticTemplateLiteral(node: AstNode, path: string): string {
  const expressions = Array.isArray(node.expressions) ? node.expressions : [];
  if (expressions.length > 0) {
    throw new UnsupportedStaticValue(path, node.type);
  }
  const quasis = Array.isArray(node.quasis) ? node.quasis as AstNode[] : [];
  return quasis.map((quasi) => {
    const value = quasi.value as { cooked?: unknown } | undefined;
    return typeof value?.cooked === "string" ? value.cooked : "";
  }).join("");
}

function staticArray(node: AstNode, path: string, warnings: string[], scope: ConstScope = EMPTY_SCOPE): unknown[] {
  const elements = Array.isArray(node.elements) ? node.elements : [];
  return elements.map((element, index) => {
    if (!element || typeof element !== "object") {
      return undefined;
    }
    const child = element as AstNode;
    if (child.type === "SpreadElement") {
      throw new UnsupportedStaticValue(`${path}[${index}]`, child.type);
    }
    return staticValueFromNode(child, `${path}[${index}]`, warnings, scope);
  });
}

function staticObject(node: AstNode, path: string, warnings: string[], scope: ConstScope = EMPTY_SCOPE): StaticRecord {
  const output: StaticRecord = {};
  const properties = Array.isArray(node.properties) ? node.properties as AstNode[] : [];

  for (const property of properties) {
    if (property.type === "SpreadElement") {
      throw new UnsupportedStaticValue(path, property.type);
    }
    if (property.type !== "Property") {
      continue;
    }
    if (property.computed === true) {
      throw new UnsupportedStaticValue(path, "computed property");
    }
    const key = keyName(property.key as AstNode | undefined);
    const value = property.value as AstNode | undefined;
    if (!key || !value) {
      continue;
    }
    output[key] = staticValueFromNode(value, `${path}.${key}`, warnings, scope);
  }

  return output;
}

function staticUnary(node: AstNode, path: string, warnings: string[], scope: ConstScope = EMPTY_SCOPE): unknown {
  const operator = node.operator;
  const argument = node.argument as AstNode | undefined;
  if (!argument) {
    throw new UnsupportedStaticValue(path, node.type);
  }
  const value = staticValueFromNode(argument, path, warnings, scope);
  if (operator === "-" && typeof value === "number") {
    return -value;
  }
  if (operator === "+" && typeof value === "number") {
    return value;
  }
  if (operator === "!" && typeof value === "boolean") {
    return !value;
  }
  throw new UnsupportedStaticValue(path, node.type);
}

function staticCall(node: AstNode, path: string, warnings: string[], scope: ConstScope = EMPTY_SCOPE): unknown {
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "MemberExpression" || callee.computed === true) {
    throw new UnsupportedStaticValue(path, node.type);
  }

  const property = callee.property as AstNode | undefined;
  const object = callee.object as AstNode | undefined;
  if (property?.type !== "Identifier" || property.name !== "join" || object?.type !== "ArrayExpression") {
    throw new UnsupportedStaticValue(path, node.type);
  }

  const args = Array.isArray(node.arguments) ? node.arguments as AstNode[] : [];
  const separator = args.length === 0
    ? ","
    : staticValueFromNode(args[0]!, `${path}.join(separator)`, warnings, scope);
  if (typeof separator !== "string") {
    throw new UnsupportedStaticValue(path, node.type);
  }

  return staticArray(object, path, warnings, scope).map((value) => {
    if (typeof value !== "string") {
      throw new UnsupportedStaticValue(path, node.type);
    }
    return value;
  }).join(separator);
}

function summarizePersona(
  persona: StaticRecord,
  agent: StaticRecord,
  source: GitHubSource | undefined,
  inputUrl: string,
): PersonaSummary {
  const id = requiredString(persona.id, "persona.id");
  const description = requiredString(persona.description, "persona.description");
  if (persona.cloud !== true) {
    throw new Error(`persona "${id}" is not opted into deploy (set "cloud": true)`);
  }

  const slug = source ? sourceSlug(source) : inferDemoKey(inputUrl, source) ?? slugify(id);
  const demo = DEMO_PERSONAS[slug];
  const model = stringValue(persona.model);
  const harness = stringValue(persona.harness) ?? null;

  return {
    id,
    name: stringValue(persona.name) ?? demo?.name ?? titleize(slug || id),
    description,
    sourceUrl: inputUrl,
    slug,
    harness,
    ...(model ? { model } : {}),
    ...(model ? { modelProvider: inferModelProvider(model, harness) } : {}),
    useSubscription: booleanValue(persona.useSubscription) ?? false,
    integrations: summarizeIntegrations(persona, demo),
    inputs: summarizeInputs(persona, demo),
    triggers: summarizeTriggers(agent, demo),
    tagline: stringValue(persona.tagline) ?? demo?.tagline ?? summarizeTagline(description),
  };
}

function summarizeInputs(
  persona: StaticRecord,
  demo: PersonaSummary | undefined,
): PersonaInputSummary[] {
  const inputs = objectValue(persona.inputs);
  if (!inputs) {
    return [];
  }

  const demoInputsByKey = new Map((demo?.inputs ?? []).map((input) => [input.key, input]));

  return Object.entries(inputs).map(([name, value]) => {
    const input = objectValue(value) ?? {};
    const key = stringValue(input.env) ?? name;
    const picker = objectValue(input.picker);
    const summaryPicker = normalizeInputPicker(picker) ?? demoInputsByKey.get(key)?.picker;
    return {
      key,
      description: stringValue(input.description) ?? "",
      optional: booleanValue(input.optional) ?? false,
      ...(typeof input.default === "string" ? { default: input.default } : {}),
      ...(summaryPicker ? { picker: summaryPicker } : {}),
    };
  });
}

function normalizeInputPicker(picker: StaticRecord | undefined): PersonaInputPicker | undefined {
  const provider = stringValue(picker?.provider);
  const resource = stringValue(picker?.resource);
  return provider && resource ? { provider, resource } : undefined;
}

function summarizeIntegrations(
  persona: StaticRecord,
  demo: PersonaSummary | undefined,
): PersonaIntegrationSummary[] {
  const integrations = objectValue(persona.integrations);
  if (!integrations) {
    return [];
  }
  const demoByProvider = new Map((demo?.integrations ?? []).map((entry) => [entry.provider, entry]));

  return Object.keys(integrations).map((provider) => ({
    provider,
    label: demoByProvider.get(provider)?.label ?? providerLabel(provider),
    providerConfigKey: demoByProvider.get(provider)?.providerConfigKey ?? providerConfigKey(provider),
    description: demoByProvider.get(provider)?.description ?? integrationDescription(provider),
  }));
}

function summarizeTriggers(
  agent: StaticRecord,
  demo: PersonaSummary | undefined,
): PersonaTriggerSummary[] {
  const triggers: PersonaTriggerSummary[] = [];
  const integrationTriggers = objectValue(agent.triggers);
  if (integrationTriggers) {
    for (const [provider, value] of Object.entries(integrationTriggers)) {
      const events = Array.isArray(value)
        ? value
            .map((entry) => objectValue(entry)?.on)
            .filter((event): event is string => typeof event === "string" && event.trim().length > 0)
        : [];
      triggers.push({
        kind: "integration",
        provider,
        label: events.length > 0
          ? `${providerLabel(provider)}: ${events.join(", ")}`
          : `${providerLabel(provider)} event`,
      });
    }
  }

  if (Array.isArray(agent.schedules)) {
    for (const schedule of agent.schedules) {
      const record = objectValue(schedule);
      if (!record) {
        continue;
      }
      const name = stringValue(record.name) ?? "Schedule";
      const cron = stringValue(record.cron) ?? stringValue(record.cronExpression);
      triggers.push({
        kind: "schedule",
        provider: "schedule",
        label: cron ? `${name} (${cron})` : name,
      });
    }
  }

  return triggers.length > 0 ? triggers : demo?.triggers ?? [];
}

function fallbackResponse(
  inputUrl: string,
  source: GitHubSource | undefined,
  error: unknown,
  existingWarnings: string[] = [],
): PersonaResolveResponse {
  const reason = error instanceof Error ? error.message : String(error);
  const warnings = [...existingWarnings, reason];
  return {
    persona: null,
    agent: null,
    bundle: null,
    summary: fallbackSummary(inputUrl, source),
    warnings,
    fallback: { reason },
  };
}

function fallbackSummary(inputUrl: string, source: GitHubSource | undefined): PersonaSummary {
  const key = inferDemoKey(inputUrl, source);
  if (key) {
    return { ...DEMO_PERSONAS[key], sourceUrl: inputUrl };
  }

  const name = source ? basename(dirname(source.filePath)) || source.repo : "persona";
  const slug = slugify(name) || "persona";
  return {
    id: slug,
    name: titleize(slug),
    description: "Persona preview is unavailable, but the launch flow can continue in demo mode.",
    sourceUrl: inputUrl,
    slug,
    harness: null,
    useSubscription: false,
    integrations: [],
    inputs: [],
    triggers: [],
    tagline: "Persona preview is unavailable.",
  };
}

function inferDemoKey(inputUrl: string, source: GitHubSource | undefined): string | undefined {
  const haystack = source?.filePath ?? inputUrl;
  const pathParts = haystack.split(/[/?#]/).flatMap((part) => part.split("/")).filter(Boolean);
  return [
    "granola",
    "hn-monitor",
    "linear",
    "repo-hygiene",
    "review",
    "spotify-releases",
    "vendor-monitor",
  ].find((key) => pathParts.includes(key) || haystack.includes(`${key}/persona.ts`));
}

function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    confluence: "Confluence",
    dropbox: "Dropbox",
    fathom: "Fathom",
    github: "GitHub",
    gitlab: "GitLab",
    granola: "Granola",
    hubspot: "HubSpot",
    jira: "Jira",
    linear: "Linear",
    notion: "Notion",
    slack: "Slack",
    spotify: "Spotify",
    stripe: "Stripe",
    x: "X",
  };
  return known[provider] ?? titleize(provider);
}

function providerConfigKey(provider: string): string {
  const known: Record<string, string> = {
    confluence: "confluence-relay",
    dropbox: "dropbox-relay",
    fathom: "fathom-relay",
    github: "github-relay",
    gitlab: "gitlab-relay",
    granola: "granola-relay",
    hubspot: "hubspot-relay",
    jira: "jira-relay",
    linear: "linear-relay",
    notion: "notion-relay",
    slack: "slack-relay",
    spotify: "spotify-relay",
    stripe: "stripe-relay",
    x: "x-relay",
  };
  return known[provider] ?? `${provider}-relay`;
}

function integrationDescription(provider: string): string {
  const known: Record<string, string> = {
    github: "Read and write GitHub records through Relayfile.",
    granola: "Read synced Granola notes through Relayfile.",
    linear: "Read and write Linear issues through Relayfile.",
    notion: "Read and write Notion records through Relayfile.",
    slack: "Post messages and read Slack records through Relayfile.",
    spotify: "Read Spotify data for scheduled release checks.",
  };
  return known[provider] ?? `Connect ${providerLabel(provider)} for this persona.`;
}

function inferModelProvider(model: string, harness?: string | null): string {
  // Self-contained harnesses (opencode) broker model access themselves, and
  // their model ids carry no provider prefix (e.g. "deepseek-v4-flash-free").
  // The split() fallback below would otherwise return the bare model id, which
  // the deploy wizard's credential routes reject as an unknown provider
  // ("provider is required"). Fall back to the harness as the provider so the
  // resolved modelProvider matches what normalizeModelProvider / resolveHouseKey
  // (house-keys.ts) recognize for opencode managed credentials.
  if (harness?.trim().toLowerCase() === "opencode") return "opencode";

  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic";
  if (normalized.startsWith("gpt") || normalized.startsWith("o1") || normalized.startsWith("o3")) return "openai";
  if (normalized.startsWith("gemini")) return "google";
  if (normalized.startsWith("openrouter/")) return "openrouter";
  return normalized.split(/[/:]/)[0] || "unknown";
}

function summarizeTagline(description: string): string | undefined {
  const firstSentence = description.match(/^(.+?[.!?])(?:\s|$)/)?.[1]?.trim();
  return firstSentence || description || undefined;
}

function sourceSlug(source: GitHubSource): string {
  return slugify(basename(dirname(source.filePath))) || source.repo;
}

function requiredString(value: unknown, label: string): string {
  const string = stringValue(value);
  if (!string) {
    throw new Error(`${label} must be a static string`);
  }
  return string;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectValue(value: unknown): StaticRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StaticRecord
    : undefined;
}

function dirname(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "." : filePath.slice(0, index);
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function normalizeRemotePath(remotePath: string): string {
  const stack: string[] = [];
  for (const part of remotePath.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`remote path escapes repository root: ${remotePath}`);
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) {
    throw new Error(`remote path is empty: ${remotePath}`);
  }
  return stack.join("/");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleize(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "hn") return "HN";
      if (lower === "pr") return "PR";
      return part[0]?.toUpperCase() + part.slice(1);
    })
    .join(" ");
}
