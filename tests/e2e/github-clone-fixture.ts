import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "../..");
const LOG_DIR = resolve(PROJECT_ROOT, ".logs");

const WORKSPACE_ID = "a0000000-0000-4000-8000-000000000001";
const GITHUB_CONNECTION_ID = "conn-github-e2e";
const GITHUB_PROVIDER_CONFIG_KEY = "github-sage";
const CLOUD_API_TOKEN = "e2e-secret";
const OWNER = "agentworkforce";
const REPO = "e2e-repo";
const REF_MAIN = "main";
const REF_DEV = "dev";

const MOCK_NANGO_BASE_URL = process.env.E2E_MOCK_NANGO_URL ?? "http://127.0.0.1:13002";
const MOCK_RELAYFILE_BASE_URL =
  process.env.E2E_MOCK_RELAYFILE_URL ?? "http://127.0.0.1:14000";
const CLOUD_WEB_BASE_URL = process.env.E2E_CLOUD_WEB_URL ?? "http://127.0.0.1:13000";

const POSTGRES_HOST = process.env.E2E_POSTGRES_HOST ?? "127.0.0.1";
const POSTGRES_PORT = Number(process.env.E2E_POSTGRES_PORT ?? "5433");
const POSTGRES_USER = process.env.E2E_POSTGRES_USER ?? "e2e";
const POSTGRES_PASSWORD = process.env.E2E_POSTGRES_PASSWORD ?? "e2e-pass";
const POSTGRES_DATABASE = process.env.E2E_POSTGRES_DATABASE ?? "e2e";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type RecorderEntry = {
  kind?: string;
  method?: string;
  path?: string;
  endpoint?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  workspaceId?: string;
  targetPath?: string;
  fileCount?: number;
  filePaths?: Array<string | null>;
  headers?: Record<string, unknown>;
  body?: unknown;
  ts?: string;
};

type AssertionResult = {
  pass: boolean;
  detail: string;
};

type CloneResponse = {
  status: number;
  body: unknown;
};

type GoldenPathEvidence = {
  pass: boolean;
  request: {
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
  };
  response: CloneResponse | null;
  nangoRecorder: RecorderEntry[];
  relayfileRecorder: RecorderEntry[];
  assertions: Record<string, AssertionResult>;
};

type ConcurrentSameRefEvidence = {
  pass: boolean;
  responses: CloneResponse[];
  tarballCalls: number;
  bulkWriteCalls: number;
  assertions: Record<string, AssertionResult>;
};

type ConcurrentDifferentRefsEvidence = {
  pass: boolean;
  responses: CloneResponse[];
  tarballCalls: number;
  tarballRefs: string[];
  bulkWriteCalls: number;
  assertions: Record<string, AssertionResult>;
};

type UnauthorizedEvidence = {
  pass: boolean;
  response: CloneResponse | null;
  nangoCalls: number;
  relayfileCalls: number;
  assertions: Record<string, AssertionResult>;
};

type EvidenceFile = {
  timestamp: string;
  runtime: {
    mockNangoBaseUrl: string;
    mockRelayfileBaseUrl: string;
    cloudWebBaseUrl: string;
    postgresHost: string;
    postgresPort: number;
  };
  goldenPath: GoldenPathEvidence;
  concurrentSameRef: ConcurrentSameRefEvidence;
  concurrentDifferentRefs: ConcurrentDifferentRefsEvidence;
  unauthorized: UnauthorizedEvidence;
  summary: {
    pass: boolean;
    failures: string[];
  };
  notes: string[];
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

function toAssertion(pass: boolean, detail: string): AssertionResult {
  return { pass, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<CloneResponse> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<CloneResponse> {
  return requestJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify(body),
  });
}

async function fetchRecorder(url: string): Promise<RecorderEntry[]> {
  const { status, body } = await requestJson(url, {
    headers: { accept: "application/json" },
  });
  if (status !== 200 || !Array.isArray(body)) {
    return [];
  }
  return body as RecorderEntry[];
}

async function resetMocks(): Promise<void> {
  await Promise.all([
    postJson(`${MOCK_NANGO_BASE_URL}/__reset`, {}),
    postJson(`${MOCK_RELAYFILE_BASE_URL}/__reset`, {}),
  ]);
}

async function seedWorkspaceIntegration(): Promise<void> {
  const client = new Client({
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DATABASE,
  });
  await client.connect();
  try {
    await client.query(
      `insert into workspace_integrations (
         workspace_id, provider, connection_id, provider_config_key,
         installation_id, metadata_json, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, now(), now())
       on conflict (workspace_id, provider) do update set
         connection_id = excluded.connection_id,
         provider_config_key = excluded.provider_config_key,
         installation_id = excluded.installation_id,
         metadata_json = excluded.metadata_json,
         updated_at = now()`,
      [
        WORKSPACE_ID,
        "github",
        GITHUB_CONNECTION_ID,
        GITHUB_PROVIDER_CONFIG_KEY,
        null,
        JSON.stringify({ installationId: null }),
      ],
    );
  } finally {
    await client.end();
  }
}

function buildCloneRequest(ref: string): JsonValue {
  return {
    workspaceId: WORKSPACE_ID,
    owner: OWNER,
    repo: REPO,
    ref,
  };
}

async function postClone(
  body: JsonValue,
  bearer: string = CLOUD_API_TOKEN,
): Promise<CloneResponse> {
  return postJson(
    `${CLOUD_WEB_BASE_URL}/api/v1/github/clone`,
    body,
    {
      authorization: `Bearer ${bearer}`,
    },
  );
}

function countRecorderKind(entries: RecorderEntry[], kind: string): number {
  return entries.filter((entry) => entry.kind === kind).length;
}

function recorderKinds(entries: RecorderEntry[], kinds: string[]): RecorderEntry[] {
  const set = new Set(kinds);
  return entries.filter((entry) => entry.kind !== undefined && set.has(entry.kind));
}

async function runGoldenPath(): Promise<GoldenPathEvidence> {
  await resetMocks();
  const request = buildCloneRequest(REF_MAIN);
  const response = await postClone(request);

  const nangoRecorder = await fetchRecorder(`${MOCK_NANGO_BASE_URL}/__recorder`);
  const relayfileRecorder = await fetchRecorder(`${MOCK_RELAYFILE_BASE_URL}/__recorder`);

  const tarballCalls = countRecorderKind(nangoRecorder, "github:tarball");
  const repoCalls = countRecorderKind(nangoRecorder, "github:repo");
  const commitCalls = countRecorderKind(nangoRecorder, "github:commits");
  const bulkWriteCalls = countRecorderKind(relayfileRecorder, "bulkWrite:request");
  const writeFileCalls = countRecorderKind(relayfileRecorder, "writeFile:request");

  const bulkWriteEntry = relayfileRecorder.find(
    (entry) => entry.kind === "bulkWrite:request",
  );
  const filesWritten =
    isRecord(response.body) && isRecord(response.body.data)
      ? Number(response.body.data.filesWritten ?? 0)
      : 0;
  const headSha =
    isRecord(response.body) && isRecord(response.body.data)
      ? String(response.body.data.headSha ?? "")
      : "";

  const ok =
    isRecord(response.body) && response.body.ok === true;

  const assertions: Record<string, AssertionResult> = {
    a_http200: toAssertion(
      response.status === 200 && ok,
      `status=${response.status} body=${JSON.stringify(response.body).slice(0, 240)}`,
    ),
    b_tarballExactlyOnce: toAssertion(
      tarballCalls === 1,
      `github:tarball calls=${tarballCalls}`,
    ),
    c_repoAndCommitsCalled: toAssertion(
      repoCalls >= 1 && commitCalls >= 1,
      `github:repo=${repoCalls}, github:commits=${commitCalls}`,
    ),
    d_bulkWriteCalled: toAssertion(
      bulkWriteCalls >= 1 &&
        Boolean(bulkWriteEntry) &&
        (bulkWriteEntry?.fileCount ?? 0) >= 1,
      `bulkWrite calls=${bulkWriteCalls}, fileCount=${bulkWriteEntry?.fileCount ?? 0}`,
    ),
    e_indexAndMetaWritten: toAssertion(
      writeFileCalls >= 2,
      `writeFile calls=${writeFileCalls} (expected >=2 for index.json + meta.json)`,
    ),
    f_filesWrittenMatches: toAssertion(
      filesWritten >= 1 && filesWritten === (bulkWriteEntry?.fileCount ?? -1),
      `response.filesWritten=${filesWritten}, bulkWrite.fileCount=${bulkWriteEntry?.fileCount ?? null}`,
    ),
    g_headShaReturned: toAssertion(
      headSha.length > 0,
      `headSha=${JSON.stringify(headSha)}`,
    ),
  };

  const pass = Object.values(assertions).every((entry) => entry.pass);

  return {
    pass,
    request: {
      workspaceId: WORKSPACE_ID,
      owner: OWNER,
      repo: REPO,
      ref: REF_MAIN,
    },
    response,
    nangoRecorder: sanitizeJson(nangoRecorder),
    relayfileRecorder: sanitizeJson(relayfileRecorder),
    assertions,
  };
}

async function runConcurrentSameRef(): Promise<ConcurrentSameRefEvidence> {
  await resetMocks();
  const request = buildCloneRequest(REF_MAIN);

  const responses = await Promise.all([
    postClone(request),
    postClone(request),
    postClone(request),
  ]);

  const nangoRecorder = await fetchRecorder(`${MOCK_NANGO_BASE_URL}/__recorder`);
  const relayfileRecorder = await fetchRecorder(`${MOCK_RELAYFILE_BASE_URL}/__recorder`);

  const tarballCalls = countRecorderKind(nangoRecorder, "github:tarball");
  const bulkWriteCalls = countRecorderKind(relayfileRecorder, "bulkWrite:request");

  const allOk = responses.every(
    (res) => res.status === 200 && isRecord(res.body) && res.body.ok === true,
  );

  const assertions: Record<string, AssertionResult> = {
    a_allSucceeded: toAssertion(
      allOk,
      `statuses=${responses.map((res) => res.status).join(",")}`,
    ),
    b_singleFlightTarball: toAssertion(
      tarballCalls === 1,
      `expected tarball calls=1 (single-flight dedup on workspace:owner/repo@ref), saw ${tarballCalls}`,
    ),
    c_singleFlightBulkWrite: toAssertion(
      bulkWriteCalls === 1,
      `expected bulkWrite calls=1 (coalesced executeClone runs once), saw ${bulkWriteCalls}`,
    ),
  };

  const pass = Object.values(assertions).every((entry) => entry.pass);
  return {
    pass,
    responses: responses.map((res) => sanitizeJson(res)),
    tarballCalls,
    bulkWriteCalls,
    assertions,
  };
}

async function runConcurrentDifferentRefs(): Promise<ConcurrentDifferentRefsEvidence> {
  await resetMocks();

  const responses = await Promise.all([
    postClone(buildCloneRequest(REF_MAIN)),
    postClone(buildCloneRequest(REF_DEV)),
  ]);

  const nangoRecorder = await fetchRecorder(`${MOCK_NANGO_BASE_URL}/__recorder`);
  const relayfileRecorder = await fetchRecorder(`${MOCK_RELAYFILE_BASE_URL}/__recorder`);

  const tarballEntries = recorderKinds(nangoRecorder, ["github:tarball"]);
  const tarballCalls = tarballEntries.length;
  const tarballRefs = tarballEntries
    .map((entry) => entry.ref)
    .filter((value): value is string => typeof value === "string");
  const bulkWriteCalls = countRecorderKind(relayfileRecorder, "bulkWrite:request");

  const allOk = responses.every(
    (res) => res.status === 200 && isRecord(res.body) && res.body.ok === true,
  );

  const distinctRefs = new Set(tarballRefs);

  const assertions: Record<string, AssertionResult> = {
    a_allSucceeded: toAssertion(
      allOk,
      `statuses=${responses.map((res) => res.status).join(",")}`,
    ),
    b_tarballHitPerRef: toAssertion(
      tarballCalls === 2,
      `expected tarball calls=2 (ref is in dedup key), saw ${tarballCalls}`,
    ),
    c_bothRefsObserved: toAssertion(
      distinctRefs.size === 2 && distinctRefs.has(REF_MAIN) && distinctRefs.has(REF_DEV),
      `observed refs=${Array.from(distinctRefs).join(",")}`,
    ),
    d_bulkWritePerRef: toAssertion(
      bulkWriteCalls === 2,
      `expected bulkWrite calls=2, saw ${bulkWriteCalls}`,
    ),
  };

  const pass = Object.values(assertions).every((entry) => entry.pass);
  return {
    pass,
    responses: responses.map((res) => sanitizeJson(res)),
    tarballCalls,
    tarballRefs,
    bulkWriteCalls,
    assertions,
  };
}

async function runUnauthorized(): Promise<UnauthorizedEvidence> {
  await resetMocks();
  const response = await postClone(buildCloneRequest(REF_MAIN), "wrong-bearer");

  const nangoRecorder = await fetchRecorder(`${MOCK_NANGO_BASE_URL}/__recorder`);
  const relayfileRecorder = await fetchRecorder(`${MOCK_RELAYFILE_BASE_URL}/__recorder`);

  const githubNangoCalls = recorderKinds(nangoRecorder, [
    "github:proxy:request",
    "github:tarball",
    "github:repo",
    "github:commits",
  ]).length;
  const relayfileCalls = recorderKinds(relayfileRecorder, [
    "bulkWrite:request",
    "writeFile:request",
    "readFile:request",
  ]).length;

  const body = isRecord(response.body) ? response.body : null;
  const code = body && typeof body.code === "string" ? body.code : null;

  const assertions: Record<string, AssertionResult> = {
    a_authRejected: toAssertion(
      [401, 403].includes(response.status),
      `status=${response.status}`,
    ),
    b_codeUnauthorized: toAssertion(
      code === "unauthorized" || code === "forbidden",
      `code=${JSON.stringify(code)}`,
    ),
    c_noNangoEgress: toAssertion(
      githubNangoCalls === 0,
      `github-related mock-nango calls=${githubNangoCalls}`,
    ),
    d_noRelayfileEgress: toAssertion(
      relayfileCalls === 0,
      `mock-relayfile calls=${relayfileCalls}`,
    ),
  };

  const pass = Object.values(assertions).every((entry) => entry.pass);
  return {
    pass,
    response,
    nangoCalls: githubNangoCalls,
    relayfileCalls,
    assertions,
  };
}

function buildSummary(evidence: EvidenceFile): EvidenceFile["summary"] {
  const failures: string[] = [];
  const collect = (phase: string, assertions: Record<string, AssertionResult>) => {
    for (const [key, assertion] of Object.entries(assertions)) {
      if (!assertion.pass) {
        failures.push(`${phase}.${key}: ${assertion.detail}`);
      }
    }
  };

  collect("goldenPath", evidence.goldenPath.assertions);
  collect("concurrentSameRef", evidence.concurrentSameRef.assertions);
  collect("concurrentDifferentRefs", evidence.concurrentDifferentRefs.assertions);
  collect("unauthorized", evidence.unauthorized.assertions);

  if (evidence.error) {
    failures.push(`driver_error: ${evidence.error.message}`);
  }

  return {
    pass: failures.length === 0,
    failures,
  };
}

function serializeError(error: unknown): EvidenceFile["error"] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { name: "Error", message: String(error) };
}

async function writeEvidenceFile(evidence: EvidenceFile): Promise<string> {
  await mkdir(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = resolve(LOG_DIR, `github-clone-e2e-${stamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return outputPath;
}

function printSummary(evidencePath: string, evidence: EvidenceFile): void {
  if (evidence.summary.pass) {
    console.log(`PASS github-clone e2e fixture driver -> ${evidencePath}`);
    return;
  }

  console.error(`FAIL github-clone e2e fixture driver -> ${evidencePath}`);
  for (const failure of evidence.summary.failures) {
    console.error(`- ${failure}`);
  }
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const notes = [
    "Seeds a github workspace_integrations row directly into Postgres so getWorkspaceIntegration(workspaceId, 'github') resolves without a real Nango connection.",
    "mock-nango handles github-style POST /proxy (JSON body) independently from slack-style /proxy/* (path-based), keeping the existing slack fixture unaffected.",
    "github-clone audit is log-only (no DB table) on this branch, so observational invariants go through mock-nango and mock-relayfile recorders instead of Postgres.",
    "Concurrent-same-ref asserts single-flight dedup including the ref axis (PR #160 Devin fix #1).",
    "Concurrent-different-refs asserts two distinct tarball fetches, proving dedup key isolates refs.",
  ];

  const evidence: EvidenceFile = {
    timestamp,
    runtime: {
      mockNangoBaseUrl: MOCK_NANGO_BASE_URL,
      mockRelayfileBaseUrl: MOCK_RELAYFILE_BASE_URL,
      cloudWebBaseUrl: CLOUD_WEB_BASE_URL,
      postgresHost: POSTGRES_HOST,
      postgresPort: POSTGRES_PORT,
    },
    goldenPath: {
      pass: false,
      request: { workspaceId: "", owner: "", repo: "", ref: "" },
      response: null,
      nangoRecorder: [],
      relayfileRecorder: [],
      assertions: {},
    },
    concurrentSameRef: {
      pass: false,
      responses: [],
      tarballCalls: 0,
      bulkWriteCalls: 0,
      assertions: {},
    },
    concurrentDifferentRefs: {
      pass: false,
      responses: [],
      tarballCalls: 0,
      tarballRefs: [],
      bulkWriteCalls: 0,
      assertions: {},
    },
    unauthorized: {
      pass: false,
      response: null,
      nangoCalls: 0,
      relayfileCalls: 0,
      assertions: {},
    },
    summary: { pass: false, failures: [] },
    notes,
  };

  try {
    await seedWorkspaceIntegration();
    evidence.goldenPath = await runGoldenPath();
    evidence.concurrentSameRef = await runConcurrentSameRef();
    evidence.concurrentDifferentRefs = await runConcurrentDifferentRefs();
    evidence.unauthorized = await runUnauthorized();
  } catch (error) {
    evidence.error = serializeError(error);
  } finally {
    evidence.summary = buildSummary(evidence);
    const evidencePath = await writeEvidenceFile(evidence);
    printSummary(evidencePath, evidence);
    if (!evidence.summary.pass || evidence.error) {
      process.exitCode = 1;
    }
  }
}

await main();
