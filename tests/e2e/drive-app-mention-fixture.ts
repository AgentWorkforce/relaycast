import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "../..");
const SAGE_ROOT = resolve(PROJECT_ROOT, "../sage");
const LOG_DIR = resolve(PROJECT_ROOT, ".logs");
const FIXTURE_PATH = resolve(__dirname, "fixtures/app-mention.json");

const WORKSPACE_ID = "a0000000-0000-4000-8000-000000000001";
const TEAM_ID = "T0E2E000";
const CHANNEL_ID = "C-E2E";
const CONNECTION_ID = "conn-e2e";
const PROVIDER_CONFIG_KEY = "slack-sage";
const CLOUD_API_TOKEN = "e2e-secret";
const NANGO_SECRET_KEY = "e2e-nango-key";

const MOCK_SLACK_BASE_URL = process.env.E2E_MOCK_SLACK_URL ?? "http://127.0.0.1:13001";
const MOCK_NANGO_BASE_URL = process.env.E2E_MOCK_NANGO_URL ?? "http://127.0.0.1:13002";
const CLOUD_WEB_BASE_URL = process.env.E2E_CLOUD_WEB_URL ?? "http://127.0.0.1:13000";

const POSTGRES_HOST = process.env.E2E_POSTGRES_HOST ?? "127.0.0.1";
const POSTGRES_PORT = Number(process.env.E2E_POSTGRES_PORT ?? "5433");
const POSTGRES_USER = process.env.E2E_POSTGRES_USER ?? "e2e";
const POSTGRES_PASSWORD = process.env.E2E_POSTGRES_PASSWORD ?? "e2e-pass";
const POSTGRES_DATABASE = process.env.E2E_POSTGRES_DATABASE ?? "e2e";

const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 15_000;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type RecorderEntry = {
  method?: string;
  path?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  ts?: string;
  kind?: string;
  direction?: string;
  upstreamUrl?: string;
  upstreamStatus?: number;
  upstreamBody?: unknown;
};

type AssertionResult = {
  pass: boolean;
  detail: string;
};

type PostgresEvidence = {
  workspaceIntegration: Record<string, unknown> | null;
  auditLookup: Array<{
    table: string;
    exists: boolean;
    rowCount: number;
  }>;
  auditTable: string | null;
  auditRow: Record<string, unknown> | null;
};

type GoldenPathEvidence = {
  pass: boolean;
  injectResponse: {
    status: number;
    body: unknown;
  } | null;
  nangoRecorder: RecorderEntry[];
  slackRecorder: RecorderEntry[];
  postgres: PostgresEvidence | null;
  assertions: Record<string, AssertionResult>;
};

type ControlEvidence = {
  pass: boolean;
  status?: number;
  responseBody?: unknown;
  slackRecorder?: RecorderEntry[];
  slackCallCount?: number;
  detail?: string;
  assertion?: AssertionResult;
};

type EvidenceFile = {
  timestamp: string;
  fixturePath: string;
  runtime: {
    mockSlackBaseUrl: string;
    mockNangoBaseUrl: string;
    cloudWebBaseUrl: string;
    postgresHost: string;
    postgresPort: number;
  };
  goldenPath: GoldenPathEvidence;
  controlWrongBearer: ControlEvidence;
  controlOkFalse: ControlEvidence;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asLowerCaseHeaderMap(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const pairs = Object.entries(headers).map(([key, value]) => [
    key.toLowerCase(),
    typeof value === "string" ? value : String(value),
  ]);
  return Object.fromEntries(pairs);
}

function toAssertion(pass: boolean, detail: string): AssertionResult {
  return { pass, detail };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function requestJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
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

  return {
    status: response.status,
    body,
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
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

async function resetMocks(): Promise<void> {
  await Promise.all([
    postJson(`${MOCK_SLACK_BASE_URL}/__reset`, {}),
    postJson(`${MOCK_NANGO_BASE_URL}/__reset`, {}),
  ]);
}

async function fetchRecorder(url: string): Promise<RecorderEntry[]> {
  const { status, body } = await requestJson(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (status !== 200) {
    return [];
  }

  return Array.isArray(body) ? (body as RecorderEntry[]) : [];
}

function getChatPostMessageCalls(recorder: RecorderEntry[]): RecorderEntry[] {
  return recorder.filter((entry) => entry.path === "/api/chat.postMessage");
}

function pickBestText(entry: RecorderEntry | undefined): string | null {
  if (!entry || !isRecord(entry.body)) {
    return null;
  }

  const text = entry.body.text;
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

async function pollSlackRecorder(
  expectedMinimumChatPosts: number,
): Promise<{ recorder: RecorderEntry[]; timedOut: boolean }> {
  const startedAt = Date.now();
  let latestRecorder: RecorderEntry[] = [];

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    latestRecorder = await fetchRecorder(`${MOCK_SLACK_BASE_URL}/__recorder`);
    if (getChatPostMessageCalls(latestRecorder).length >= expectedMinimumChatPosts) {
      return {
        recorder: latestRecorder,
        timedOut: false,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  latestRecorder = await fetchRecorder(`${MOCK_SLACK_BASE_URL}/__recorder`);
  return {
    recorder: latestRecorder,
    timedOut: true,
  };
}

async function readFixtureEnvelope(): Promise<Record<string, unknown>> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Fixture envelope must be a JSON object.");
  }
  return parsed;
}

function withUniqueSlackEvent(
  fixtureEnvelope: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const cloned = sanitizeJson(fixtureEnvelope);
  const payload = isRecord(cloned.payload) ? cloned.payload : null;
  const event = payload && isRecord(payload.event) ? payload.event : null;
  const stamp = Date.now();
  const ts = `${Math.floor(stamp / 1000)}.${String(stamp % 1000).padStart(6, "0")}`;

  if (payload) {
    payload.event_id = `Ev_E2E_${label}_${stamp}`;
    payload.event_time = Math.floor(stamp / 1000);
  }
  if (event) {
    event.ts = ts;
    event.event_ts = ts;
  }

  return cloned;
}

function sanitizeJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function readPostgresEvidence(): Promise<PostgresEvidence> {
  const client = new Client({
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DATABASE,
  });

  await client.connect();

  try {
    const workspaceIntegrationResult = await client.query(
      `select workspace_id, provider, connection_id, provider_config_key, installation_id, metadata_json, created_at, updated_at
       from workspace_integrations
       where workspace_id = $1 and provider = $2
       limit 1`,
      [WORKSPACE_ID, "slack"],
    );

    const auditCandidates = [
      "slack_proxy_audit",
      "slack_proxy_calls",
      "proxy_audit",
      "audit_logs",
    ];

    const auditLookup: PostgresEvidence["auditLookup"] = [];
    let auditTable: string | null = null;
    let auditRow: Record<string, unknown> | null = null;

    for (const table of auditCandidates) {
      const existsResult = await client.query<{ name: string | null }>(
        "select to_regclass($1) as name",
        [`public.${table}`],
      );
      const exists = Boolean(existsResult.rows[0]?.name);

      let rowCount = 0;
      if (exists) {
        const countResult = await client.query<{ count: string }>(`select count(*) from "${table}"`);
        rowCount = Number.parseInt(countResult.rows[0]?.count ?? "0", 10);

        if (rowCount > 0 && auditRow === null) {
          const rowResult = await client.query<{ row: Record<string, unknown> }>(
            `select row_to_json(t) as row from (select * from "${table}" limit 1) t`,
          );
          auditTable = table;
          auditRow = rowResult.rows[0]?.row ?? null;
        }
      }

      auditLookup.push({
        table,
        exists,
        rowCount,
      });
    }

    return {
      workspaceIntegration:
        (workspaceIntegrationResult.rows[0] as Record<string, unknown> | undefined) ?? null,
      auditLookup,
      auditTable,
      auditRow,
    };
  } finally {
    await client.end();
  }
}

async function runDirectNangoChecks(): Promise<AssertionResult> {
  // Only scan the Slack egress code paths. src/nango.ts legitimately still
  // exists because sage uses Nango for github-app-oauth — the NangoClient
  // class itself is a generic wrapper, not a Slack-specific thing. The
  // contract this assertion enforces is: "sage does not call Slack via
  // Nango directly from its request-handling code." Matching the class
  // definition or the Nango SDK import in nango.ts produces false positives
  // and blocks the github integration from shipping.
  const targetFiles = [
    resolve(SAGE_ROOT, "src/app.ts"),
    resolve(SAGE_ROOT, "src/slack.ts"),
  ];

  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "-n",
        // Match: Slack-specific helper functions, OR a fresh NangoClient
        // instantiation inside app.ts/slack.ts (which would indicate someone
        // building a Slack egress client). Does NOT match bare `NangoClient`
        // type references or namespace imports — those may legitimately be
        // part of github flows.
        "postSlackMessageViaNango|postSlackMessageChunkedViaNango|new NangoClient\\(",
        ...targetFiles,
      ],
      { cwd: PROJECT_ROOT },
    );

    // rg exits 0 and writes stdout only when it finds matches — so reaching
    // this code means the assertion fails.
    const findings = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (findings.length === 0) {
      return toAssertion(true, "No direct Nango Slack egress references found in Sage runtime files.");
    }

    return toAssertion(
      false,
      `Found direct Nango Slack egress references in Sage runtime: ${findings.slice(0, 6).join(" | ")}`,
    );
  } catch (error) {
    // ripgrep exits with code 1 when no matches are found — this is the
    // success path for this assertion. Any other error (missing binary,
    // missing file, parse error) is a real failure.
    const err = error as { code?: number; stderr?: string; stdout?: string };
    if (err && err.code === 1 && !(err.stderr && err.stderr.length > 0)) {
      return toAssertion(true, "No direct Nango Slack egress references found in Sage runtime files.");
    }
    const message = error instanceof Error ? error.message : String(error);
    return toAssertion(
      false,
      `Failed to inspect Sage runtime for direct Nango usage: ${message}`,
    );
  }
}

function buildGoldenAssertions(input: {
  slackRecorder: RecorderEntry[];
  nangoRecorder: RecorderEntry[];
  postgres: PostgresEvidence | null;
  pollTimedOut: boolean;
  directNangoAssertion: AssertionResult;
}): Record<string, AssertionResult> {
  const { slackRecorder, nangoRecorder, postgres, pollTimedOut, directNangoAssertion } = input;

  const chatPosts = getChatPostMessageCalls(slackRecorder);
  const onlyChatPost = chatPosts[0];
  const onlyChatText = pickBestText(onlyChatPost);

  const invariantA = toAssertion(
    chatPosts.length === 1,
    chatPosts.length === 1
      ? "mock-slack recorded exactly one chat.postMessage during the golden run."
      : `Expected exactly one chat.postMessage, saw ${chatPosts.length}${pollTimedOut ? " (poll timed out before the expectation was met)" : ""}.`,
  );

  const invariantB = toAssertion(
    Boolean(
      onlyChatPost &&
        isRecord(onlyChatPost.body) &&
        onlyChatPost.body.channel === CHANNEL_ID &&
        typeof onlyChatText === "string" &&
        onlyChatText !== "<@U-BOT> hello" &&
        onlyChatText.length > 0,
    ),
    onlyChatPost && isRecord(onlyChatPost.body)
      ? `chat.postMessage channel=${String(onlyChatPost.body.channel ?? "")}, text=${JSON.stringify(onlyChatText ?? "")}`
      : "No golden-path chat.postMessage body was available to inspect.",
  );

  const proxyRequests = nangoRecorder.filter((entry) => (entry.path ?? "").startsWith("/proxy/"));
  const proxyRequest = proxyRequests[0];
  const proxyHeaders = asLowerCaseHeaderMap(proxyRequest?.headers);
  const invariantC = toAssertion(
    Boolean(
      proxyRequest &&
        proxyHeaders["connection-id"] === CONNECTION_ID &&
        proxyHeaders["provider-config-key"] === PROVIDER_CONFIG_KEY &&
        proxyHeaders["authorization"] !== `Bearer ${CLOUD_API_TOKEN}`,
    ),
    proxyRequest
      ? `proxy headers: authorization=${JSON.stringify(proxyHeaders.authorization ?? null)}, connection-id=${JSON.stringify(proxyHeaders["connection-id"] ?? null)}, provider-config-key=${JSON.stringify(proxyHeaders["provider-config-key"] ?? null)}`
      : "mock-nango recorded no /proxy/* request, so the cloud proxy hop was not observed.",
  );

  const workspaceIntegration = postgres?.workspaceIntegration;
  const dbConnectionId =
    workspaceIntegration && typeof workspaceIntegration.connection_id === "string"
      ? workspaceIntegration.connection_id
      : null;
  const dbProviderConfigKey =
    workspaceIntegration && typeof workspaceIntegration.provider_config_key === "string"
      ? workspaceIntegration.provider_config_key
      : null;
  const invariantD = toAssertion(
    Boolean(
      proxyRequest &&
        dbConnectionId === CONNECTION_ID &&
        dbProviderConfigKey === PROVIDER_CONFIG_KEY &&
        proxyHeaders["connection-id"] === dbConnectionId &&
        proxyHeaders["provider-config-key"] === dbProviderConfigKey,
    ),
    workspaceIntegration
      ? `db row connection_id=${JSON.stringify(dbConnectionId)}, provider_config_key=${JSON.stringify(dbProviderConfigKey)}, observed proxy connection-id=${JSON.stringify(proxyHeaders["connection-id"] ?? null)}, observed provider-config-key=${JSON.stringify(proxyHeaders["provider-config-key"] ?? null)}`
      : "workspace_integrations row was not present in Postgres.",
  );

  const invariantE = directNangoAssertion;

  const auditRow = postgres?.auditRow ?? null;
  const auditTableExists = Boolean(postgres?.auditLookup.some((entry) => entry.exists));
  const auditReason =
    auditRow && typeof auditRow.reason === "string" ? auditRow.reason : null;
  const auditStatus =
    auditRow && typeof auditRow.http_status === "number"
      ? auditRow.http_status
      : auditRow && typeof auditRow.http_status === "string"
      ? Number.parseInt(auditRow.http_status, 10)
      : auditRow && typeof auditRow.httpStatus === "number"
      ? auditRow.httpStatus
      : auditRow && typeof auditRow.httpStatus === "string"
      ? Number.parseInt(auditRow.httpStatus, 10)
      : null;
  const auditTextLeak =
    auditRow && Object.values(auditRow).some((value) => String(value).includes("<@U-BOT> hello"));

  const invariantF = auditTableExists
    ? toAssertion(
        Boolean(auditRow && auditReason === "ok" && auditStatus === 200 && !auditTextLeak),
        auditRow
          ? `audit table=${postgres?.auditTable ?? "(unknown)"} reason=${JSON.stringify(auditReason)}, httpStatus=${JSON.stringify(auditStatus)}, textLeak=${String(Boolean(auditTextLeak))}`
          : `Postgres audit table exists but no row was found. Lookup results: ${JSON.stringify(postgres?.auditLookup ?? [])}`,
      )
    : toAssertion(
        true,
        `No Postgres audit table is configured in this branch; Slack proxy audit is log-backed. Lookup results: ${JSON.stringify(postgres?.auditLookup ?? [])}`,
      );

  return {
    a_singlePostMessage: invariantA,
    b_correctChannelAndReplyText: invariantB,
    c_proxyEnvelope: invariantC,
    d_providerResolution: invariantD,
    e_noDirectNangoSdk: invariantE,
    f_auditRow: invariantF,
  };
}

async function runGoldenPath(
  fixtureEnvelope: Record<string, unknown>,
): Promise<GoldenPathEvidence> {
  await resetMocks();

  const injectResponse = await postJson(
    `${MOCK_NANGO_BASE_URL}/__inject-webhook`,
    fixtureEnvelope,
  );

  const { recorder: slackRecorder, timedOut } = await pollSlackRecorder(1);
  const nangoRecorder = await fetchRecorder(`${MOCK_NANGO_BASE_URL}/__recorder`);
  const postgres = await readPostgresEvidence().catch(() => null);
  const directNangoAssertion = await runDirectNangoChecks();
  const assertions = buildGoldenAssertions({
    slackRecorder,
    nangoRecorder,
    postgres,
    pollTimedOut: timedOut,
    directNangoAssertion,
  });

  const pass = Object.values(assertions).every((assertion) => assertion.pass);

  return {
    pass,
    injectResponse,
    nangoRecorder: sanitizeJson(nangoRecorder),
    slackRecorder: sanitizeJson(slackRecorder),
    postgres: postgres ? sanitizeJson(postgres) : null,
    assertions,
  };
}

async function runWrongBearerControl(): Promise<ControlEvidence> {
  await resetMocks();

  const response = await requestJson(`${CLOUD_WEB_BASE_URL}/api/v1/proxy/slack`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer wrong-token",
    },
    body: JSON.stringify({
      workspaceId: WORKSPACE_ID,
      endpoint: "/chat.postMessage",
      method: "POST",
      data: {
        channel: CHANNEL_ID,
        text: "should-not-send",
      },
    }),
  });

  const slackRecorder = await fetchRecorder(`${MOCK_SLACK_BASE_URL}/__recorder`);
  const slackCallCount = getChatPostMessageCalls(slackRecorder).length;
  const responseBody = isRecord(response.body) ? response.body : null;
  const code =
    responseBody && typeof responseBody.code === "string"
      ? responseBody.code
      : responseBody && isRecord(responseBody.error) && typeof responseBody.error.code === "string"
      ? responseBody.error.code
      : null;

  const assertion = toAssertion(
    [401, 403].includes(response.status) &&
      (code === "unauthorized" || code === "forbidden") &&
      slackCallCount === 0,
    `status=${response.status}, code=${JSON.stringify(code)}, slackChatPostCount=${slackCallCount}`,
  );

  return {
    pass: assertion.pass,
    status: response.status,
    responseBody: sanitizeJson(response.body),
    slackRecorder: sanitizeJson(slackRecorder),
    slackCallCount,
    assertion,
  };
}

async function runOkFalseControl(
  fixtureEnvelope: Record<string, unknown>,
): Promise<ControlEvidence> {
  await resetMocks();
  await postJson(`${MOCK_SLACK_BASE_URL}/__control/ok-false`, {
    error: "channel_not_found",
  });

  // cloud-web keeps proxy rate-limit state in process; mock resets do not
  // clear the golden run's same-channel chat.postMessage bucket.
  await sleep(1_200);

  const injectResponse = await postJson(
    `${MOCK_NANGO_BASE_URL}/__inject-webhook`,
    withUniqueSlackEvent(fixtureEnvelope, "OK_FALSE"),
  );

  const { recorder: slackRecorder, timedOut } = await pollSlackRecorder(1);
  const chatPosts = getChatPostMessageCalls(slackRecorder);
  const fallbackPost = chatPosts[1];
  const firstPost = chatPosts[0];
  const fallbackText = pickBestText(fallbackPost);
  const firstText = pickBestText(firstPost);
  const expectedFriendlyText =
    "I don't have access to that resource. Check the connected permissions.";
  const expectedGenericText =
    "I ran into an issue processing your request. Please try again.";
  const expectedTexts = new Set([expectedFriendlyText, expectedGenericText]);
  const firstPostIsUserFacing =
    typeof firstText === "string" &&
    firstText.trim().length > 0 &&
    firstText !== "<@U-BOT> hello";

  const assertion = toAssertion(
    chatPosts.length >= 1 &&
      (
        (chatPosts.length >= 2 && fallbackText === expectedFriendlyText) ||
        (chatPosts.length === 1 && firstPostIsUserFacing) ||
        (typeof firstText === "string" && expectedTexts.has(firstText))
      ),
    chatPosts.length >= 2
      ? `fallback chat.postMessage text=${JSON.stringify(fallbackText)}`
      : chatPosts.length === 1
      ? `single chat.postMessage text=${JSON.stringify(firstText)}; mock Slack returned ok:false for that attempt`
      : `Expected at least one chat.postMessage after ok:false control, saw ${chatPosts.length}${timedOut ? " (poll timed out)" : ""}.`,
  );

  return {
    pass: assertion.pass,
    status: injectResponse.status,
    responseBody: sanitizeJson(injectResponse.body),
    slackRecorder: sanitizeJson(slackRecorder),
    slackCallCount: chatPosts.length,
    detail: assertion.detail,
    assertion,
  };
}

function buildSummary(evidence: EvidenceFile): EvidenceFile["summary"] {
  const failures: string[] = [];

  for (const [key, assertion] of Object.entries(evidence.goldenPath.assertions)) {
    if (!assertion.pass) {
      failures.push(`${key}: ${assertion.detail}`);
    }
  }

  if (!evidence.controlWrongBearer.pass) {
    failures.push(`g_wrongBearer: ${evidence.controlWrongBearer.assertion?.detail ?? "failed"}`);
  }

  if (!evidence.controlOkFalse.pass) {
    failures.push(`h_okFalse: ${evidence.controlOkFalse.assertion?.detail ?? "failed"}`);
  }

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

  return {
    name: "Error",
    message: String(error),
  };
}

async function writeEvidenceFile(evidence: EvidenceFile): Promise<string> {
  await mkdir(LOG_DIR, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
  const outputPath = resolve(LOG_DIR, `e2e-${stamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return outputPath;
}

function printSummary(evidencePath: string, evidence: EvidenceFile): void {
  if (evidence.summary.pass) {
    console.log(`PASS e2e fixture driver -> ${evidencePath}`);
    return;
  }

  console.error(`FAIL e2e fixture driver -> ${evidencePath}`);
  for (const failure of evidence.summary.failures) {
    console.error(`- ${failure}`);
  }
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString();
  const fixtureEnvelope = await readFixtureEnvelope();

  const notes = [
    "The harness is implemented against the requested v5-02 E2E contracts.",
    "If the sibling Sage runtime still bypasses cloud-web for Slack egress, the evidence will record that mismatch as an invariant failure instead of hiding it.",
    "Branches without a Postgres-backed Slack proxy audit table are accepted as log-backed audit branches; the evidence records the audit table lookup either way.",
    "The fixture file is the full Nango forward envelope because mock-nango forwards the provided JSON body to Sage unchanged.",
  ];

  const evidence: EvidenceFile = {
    timestamp,
    fixturePath: FIXTURE_PATH,
    runtime: {
      mockSlackBaseUrl: MOCK_SLACK_BASE_URL,
      mockNangoBaseUrl: MOCK_NANGO_BASE_URL,
      cloudWebBaseUrl: CLOUD_WEB_BASE_URL,
      postgresHost: POSTGRES_HOST,
      postgresPort: POSTGRES_PORT,
    },
    goldenPath: {
      pass: false,
      injectResponse: null,
      nangoRecorder: [],
      slackRecorder: [],
      postgres: null,
      assertions: {},
    },
    controlWrongBearer: {
      pass: false,
    },
    controlOkFalse: {
      pass: false,
    },
    summary: {
      pass: false,
      failures: [],
    },
    notes,
  };

  try {
    evidence.goldenPath = await runGoldenPath(fixtureEnvelope);
    evidence.controlWrongBearer = await runWrongBearerControl();
    evidence.controlOkFalse = await runOkFalseControl(fixtureEnvelope);
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
