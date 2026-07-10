import { defineAgent, draftFile, encodeSegment, writeJsonFile } from "@agentworkforce/runtime";
import {
  claimIssueDispatch as claimIssueDispatchShared,
  issueDispatchClaimOutcome,
  releaseIssueDispatchClaim as releaseIssueDispatchClaimShared,
  renderCreateProxyPrScriptSource,
  renderMaterializeScriptSource,
  renderScriptRuntimeSource,
  type IssueDispatchClaim,
  type IssueDispatchClaimConfig,
  type IssueDispatchClaimResult,
} from "../_shared/issue-resolver";

const REPO_OWNER = "AgentWorkforce";
const REPO_NAME = "cloud";
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;
const LABEL = "small";
const DEFAULT_SLACK_CHANNEL = "proj-cloud";
const STATE_ROOT = "_agents/cloud-small-issue-codex";
const WORKFLOW_NAME = "cloud-small-issue-codex";
const DISPATCH_CLAIM_ROOT = "/github/_agents/cloud-small-issue-codex/dispatch-claims";
const RELAYFILE_CORRELATION_ID = "cloud-small-issue-codex";
const DISPATCH_CLAIM_TIMEOUT_MS = 10_000;
const DISPATCH_CLAIM_MAX_ATTEMPTS = 3;
const DISPATCH_CLAIM_RETRY_BACKOFF_MS = 500;
const ARCHIVE_LEASE_MATERIALIZE_FLAG =
  "CLOUD_SMALL_ISSUE_ARCHIVE_LEASE_MATERIALIZE_ENABLED";

const ISSUE_RESOLVER_MATERIALIZE_SCRIPT_CONFIG = {
  personaId: WORKFLOW_NAME,
  relayfileCorrelationId: RELAYFILE_CORRELATION_ID,
  tempPrefix: "cloud-small-issue-",
  localTempPrefix: "cloud-small-issue-local-",
  archiveTempPrefix: "cloud-small-issue-archive-",
  gitUserEmail: "cloud-small-issue-codex@agentworkforce.local",
  gitUserName: "cloud-small-issue-codex",
};

const ISSUE_DISPATCH_CLAIM_CONFIG: IssueDispatchClaimConfig = {
  repoOwner: REPO_OWNER,
  repoName: REPO_NAME,
  repoFullName: REPO_FULL_NAME,
  claimRoot: DISPATCH_CLAIM_ROOT,
  correlationId: RELAYFILE_CORRELATION_ID,
  agentIdFallback: WORKFLOW_NAME,
  credentialSource: "ctx-with-env-fallback",
  claimPutPolicy: {
    kind: "bounded-timeout",
    maxAttempts: DISPATCH_CLAIM_MAX_ATTEMPTS,
    timeoutMs: DISPATCH_CLAIM_TIMEOUT_MS,
    backoffMs: DISPATCH_CLAIM_RETRY_BACKOFF_MS,
  },
  unknownStatePolicy: "fail-closed",
  degradedHttpPolicy: "fail-open",
  diagnostics: "include",
};

type IssueState = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  prUrl?: string;
  branch?: string;
  codexSummary?: string;
};

const agentHandler = async (ctx, event) => {
  // v4 runtime event contract: `envelopeToAgentEvent` no longer produces a
  // `source`/`payload` split (the pre-v4 `shimEnvelope` shape). Relaycast/Slack
  // messages arrive as `event.type === "relaycast.message"`; provider events
  // arrive as `event.type === "<provider>.<action>"` with the provider at
  // `event.resource.provider`. The raw payload is loaded via
  // `await event.expand("full")` → `.data` (cloud's original envelope
  // `resource` field), not a synchronous `event.payload`.
  if (event.type === "relaycast.message") {
    await handleSlackMessage(ctx, event);
    return;
  }

  if (event.resource?.provider !== "github") {
    ctx.log("info", "ignoring unsupported event source", {
      provider: event.resource?.provider,
      type: event.type,
    });
    return;
  }
  if (event.type !== "github.issues.opened" && event.type !== "github.issues.labeled") {
    ctx.log("info", "ignoring non-issue event", { type: event.type });
    return;
  }

  const full = await event.expand("full");
  const resource = asRecord(full?.data);
  const issue = maybeRecord(resource.issue) ?? resource;
  const repo = asRecord(resource.repository);
  const fullName = stringValue(repo?.full_name) ?? REPO_FULL_NAME;
  if (fullName !== REPO_FULL_NAME) {
    ctx.log("info", "ignoring event for different repo", { fullName });
    return;
  }

  const issueState = stringValue(issue.state ?? resource.state)?.toLowerCase();
  if (issueState !== "open") {
    ctx.log("info", "skipping non-open issue", { issueState, eventId: event.id });
    return;
  }

  const labels = readLabels(issue.labels ?? resource.labels);
  if (!labels.includes(LABEL)) {
    ctx.log("info", "skipping issue without small label", { labels, eventId: event.id });
    return;
  }
  // Precedence guard: a `complex`-labeled issue is owned by the
  // cloud-complex-issue-workflow multi-stage persona. If both labels are present,
  // defer to it so a dual-labeled issue does not produce two competing PRs.
  if (labels.includes("complex")) {
    ctx.log("info", "skipping issue claimed by complex workflow", { labels, eventId: event.id });
    return;
  }

  const issueNumber = numberValue(issue.number ?? resource.number);
  if (!issueNumber) {
    ctx.log("warn", "missing issue number", { eventId: event.id });
    return;
  }
  const issueTitle = stringValue(issue.title ?? resource.title) ?? "(no title)";
  const issueBody = stringValue(issue.body ?? resource.body) ?? "";
  const issueUrl =
    stringValue(issue.html_url ?? resource.html_url) ??
    `https://github.com/${REPO_FULL_NAME}/issues/${issueNumber}`;
  const channel = String(ctx.persona.inputs.SLACK_CHANNEL || DEFAULT_SLACK_CHANNEL);
  const archiveLeaseMaterializeEnabled = readBooleanPersonaInput(
    ctx.persona?.inputs?.[ARCHIVE_LEASE_MATERIALIZE_FLAG],
  );

  const claim = await claimIssueDispatch(ctx, {
    eventId: event.id,
    issueNumber,
    issueTitle,
  });
  logResolverExitDiagnostic(ctx, "dispatch-claim outcome", {
    issueNumber,
    eventId: event.id,
    outcome: issueDispatchClaimOutcome(claim),
    ...claim.diagnostic,
  });
  if (!claim.proceed) {
    return;
  }

  const initialState: IssueState = { issueNumber, issueTitle, issueUrl };
  let handoff: { channel: string; ts: string } | null = null;
  let finalState = initialState;
  let workflowDispatched = false;
  try {
    handoff = await postSlack(ctx, channel,
      `Picking up <${issueUrl}|${REPO_FULL_NAME}#${issueNumber}>: ${escapeSlack(issueTitle)}. ` +
      "I will run the small-issue workflow and post the PR back here.",
    );

    // Only the durable-claim path is idempotent; fail-open paths still dispatch
    // work, but must not post the duplicate-prone GitHub claim comment.
    if (claim.claim) {
      try {
        const posted = await commentIssue(ctx, issueNumber,
          `Proactive agent \`cloud-small-issue-codex\` picked this up. ` +
          `Workflow dispatch is starting; Slack thread: #${channel}${handoff?.ts ? ` (${handoff.ts})` : ""}.`,
        );
        logResolverExitDiagnostic(ctx, "claim-comment outcome", {
          issueNumber,
          outcome: posted ? "posted" : "dropped-unavailable",
        });
      } catch (error) {
        logResolverExitDiagnostic(ctx, "claim-comment outcome", {
          issueNumber,
          outcome: "failed",
          error: errMsg(error),
        });
        throw error;
      }
    } else {
      logResolverExitDiagnostic(ctx, "claim-comment outcome", {
        issueNumber,
        outcome: "skipped-fail-open",
      });
    }

    if (handoff?.ts) {
      await writeThreadState(ctx, handoff.ts, initialState);
    }

    await ctx.files.write(`workflows/${WORKFLOW_NAME}.ts`, workflowSource({
      issueNumber,
      issueTitle,
      issueBody,
      issueUrl,
      archiveLeaseMaterializeEnabled,
    }));
    const run = await ctx.workflow.run(WORKFLOW_NAME, {
      issueNumber,
      issueTitle,
      issueBody,
      issueUrl,
    });
    workflowDispatched = true;
    const completion = await run.completion();
    finalState = {
      ...initialState,
      ...parseWorkflowOutput(completion.output),
      codexSummary: summarizeWorkflowOutput(completion.output),
    };
    const success = completion.status === "success";
    const resultText = success
      ? `Workflow completed for #${issueNumber}${finalState.prUrl ? `: ${finalState.prUrl}` : "."}`
      : `Workflow finished with status ${completion.status} for #${issueNumber}.`;
    await postSlackReply(ctx, channel, handoff?.ts, resultText);
    if (finalState.prUrl) {
      await commentIssue(ctx, issueNumber, `Opened PR: ${finalState.prUrl}`);
    } else if (!success) {
      await commentIssue(
        ctx,
        issueNumber,
        [
          `Workflow finished with status \`${completion.status}\` and did not open a PR.`,
          finalState.codexSummary ? `\nSummary:\n\`\`\`\n${finalState.codexSummary}\n\`\`\`` : "",
        ].join(""),
      );
    }
  } catch (error) {
    const message = errMsg(error);
    if (!workflowDispatched && claim.claim) {
      await releaseIssueDispatchClaim(ctx, claim.claim);
    }
    finalState = { ...initialState, codexSummary: `Workflow dispatch failed: ${message}` };
    await postSlackReply(ctx, channel, handoff?.ts, `Workflow dispatch failed for #${issueNumber}: ${message}`);
    await commentIssue(ctx, issueNumber, `Workflow dispatch failed: ${message}`);
  }

  if (handoff?.ts) {
    await writeThreadState(ctx, handoff.ts, finalState);
  }
};

export default defineAgent({
  triggers: {
    github: [
      {
        on: "issues.opened",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
      },
      {
        on: "issues.labeled",
        paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
        // Dispatch-level gate: only a `small` label wakes this persona —
        // every other labeled event used to provision a sandbox just to
        // discover the wrong label in-handler. The in-handler check stays
        // as defense-in-depth (issues.opened has no label payload).
        where: "label.name=small",
      },
    ],
    slack: [
      {
        on: "message",
        // #proj-cloud channel ID. Watch paths MUST use the channel ID, not the
        // name — inbound slack message events are keyed by ID
        // (/slack/channels/<id>/messages/...), so a name-based path silently
        // never matches and the deploy falls back to waking on every channel.
        paths: ["/slack/channels/C0AD7UU0J1G/messages/**"],
      },
    ],
  },
  handler: agentHandler,
});

export async function handleSlackMessage(ctx: any, event: any): Promise<void> {
  const full = await event.expand("full");
  const payload = asRecord(full?.data);
  const channel = stringValue(event.channel) ?? stringValue(payload.channel) ?? DEFAULT_SLACK_CHANNEL;
  if (channel !== DEFAULT_SLACK_CHANNEL) return;
  // V1 safety: Slack echoes bot/app-authored replies as fresh message events
  // with fresh ids, so broad bot filtering prevents self-answer loops.
  if (stringValue(payload.bot_id) || payload.subtype === "bot_message") return;

  const threadTs = stringValue(payload.thread_ts) ?? stringValue(payload.ts);
  const messageTs = stringValue(payload.ts) ?? event.id;
  const text = stringValue(payload.text) ?? "";
  if (!threadTs || !text.trim() || threadTs === messageTs) return;

  // This marker is a local guard for duplicate event deliveries. It is not
  // atomic; upstream integration-watch delivery claims provide the race-safe
  // idempotency gate for concurrent duplicate events.
  const markerPath = `${STATE_ROOT}/events/${safeName(event.id)}.json`;
  if (await fileExists(ctx, markerPath)) return;
  await ctx.files.write(markerPath, JSON.stringify({ handledAt: new Date().toISOString() }));

  const state = await readThreadState(ctx, threadTs);
  if (!state) return;

  const answer = await ctx.harness.run({
    prompt: [
      `Issue: ${state.issueUrl}`,
      `Title: ${state.issueTitle}`,
      state.prUrl ? `PR: ${state.prUrl}` : "",
      state.branch ? `Branch: ${state.branch}` : "",
      state.codexSummary ? `Workflow summary:\n${state.codexSummary}` : "",
      "",
      `Slack question:\n${text}`,
      "",
      "Answer in the Slack thread. Be concise and do not claim access to details not present in the context.",
    ].filter(Boolean).join("\n"),
  });

  await postSlackReply(ctx, channel, threadTs, answer.output.trim() || "I do not have enough context to answer that yet.");
}

async function postSlack(ctx: any, channel: string, text: string): Promise<{ channel: string; ts: string } | null> {
  try {
    // Slack delivery must never kill the persona — workflow dispatch + PR
    // creation are the contract. `writeJsonFile`'s own `writebackTimeoutMs`
    // only bounds the receipt-poll *after* the draft write lands; a wedged
    // relayfile FUSE mount can hang the underlying mkdir/writeFile/rename
    // syscalls themselves, which no adapter option covers. Race against a
    // hard wall-clock deadline so that failure mode can't stall the claim
    // comment + PR behind it.
    const result = await withHardTimeout(
      writeJsonFile(
        relayfileClient(ctx),
        "slack",
        "post",
        `/slack/channels/${encodeSegment(channel)}/messages/${draftFile("create message")}`,
        { text },
      ),
      WRITEBACK_HARD_TIMEOUT_MS,
      "slack VFS post",
    );
    return { channel, ts: receiptTimestamp(result.receipt) };
  } catch (error) {
    ctx.log?.("warn", "slack VFS post failed; continuing without slack handoff", {
      channel,
      error: errMsg(error),
    });
    return null;
  }
}

async function postSlackReply(ctx: any, channel: string, threadTs: string | undefined, text: string): Promise<void> {
  if (!threadTs) {
    await postSlack(ctx, channel, text);
    return;
  }
  try {
    // See postSlack: never let a wedged writeback hang the persona.
    await withHardTimeout(
      writeJsonFile(
        relayfileClient(ctx),
        "slack",
        "reply",
        `/slack/channels/${encodeSegment(channel)}/messages/${encodeSegment(threadTs)}/replies/${draftFile("reply")}`,
        { text },
      ),
      WRITEBACK_HARD_TIMEOUT_MS,
      "slack VFS reply",
    );
  } catch (error) {
    ctx.log?.("warn", "slack VFS reply failed; continuing", {
      channel,
      threadTs,
      error: errMsg(error),
    });
  }
}

export async function claimIssueDispatch(ctx: any, issue: {
  eventId?: string;
  issueNumber: number;
  issueTitle: string;
}): Promise<IssueDispatchClaimResult> {
  return claimIssueDispatchShared(ctx, issue, ISSUE_DISPATCH_CLAIM_CONFIG);
}

export async function releaseIssueDispatchClaim(ctx: any, claim: IssueDispatchClaim): Promise<void> {
  return releaseIssueDispatchClaimShared(ctx, claim, ISSUE_DISPATCH_CLAIM_CONFIG);
}

function readBooleanPersonaInput(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function commentIssue(ctx: any, number: number, body: string): Promise<boolean> {
  try {
    // See postSlack: never let a wedged writeback hang the persona.
    await withHardTimeout(
      writeJsonFile(
        relayfileClient(ctx),
        "github",
        "comment",
        `/github/repos/${encodeSegment(REPO_OWNER)}/${encodeSegment(REPO_NAME)}/issues/${encodeSegment(number)}/comments/${draftFile("comment")}`,
        { body },
      ),
      WRITEBACK_HARD_TIMEOUT_MS,
      "github VFS comment",
    );
    return true;
  } catch (error) {
    // Warn instead of dropping observability silently, but never let comment delivery break the claim flow.
    ctx.log?.("warn", "github VFS comment failed; comment dropped", {
      issueNumber: number,
      bodyPreview: body.slice(0, 120),
      error: errMsg(error),
    });
    return false;
  }
}

// Hard wall-clock ceiling on relayfile writeback calls. `writeJsonFile`'s own
// `writebackTimeoutMs` (default 3s) only bounds the receipt-poll after the
// draft write succeeds — it can't help if the underlying mkdir/writeFile/
// rename syscalls themselves wedge against an unresponsive FUSE mount. This
// wraps the whole call so that failure mode degrades to the same fail-open
// path as any other writeback error, instead of hanging the persona forever.
const WRITEBACK_HARD_TIMEOUT_MS = 12_000;

class WritebackHardTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not settle within ${ms}ms`);
    this.name = "WritebackHardTimeoutError";
  }
}

function withHardTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WritebackHardTimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function relayfileClient(ctx: any) {
  return { workspaceCwd: ctx.sandbox.cwd };
}

function receiptTimestamp(receipt: any): string {
  return stringValue(receipt?.created) ??
    stringValue(receipt?.id) ??
    stringValue(receipt?.identifier) ??
    stringValue(receipt?.externalId) ??
    "";
}

function logResolverExitDiagnostic(ctx: any, message: string, fields: Record<string, unknown>): void {
  // TEMP DIAGNOSTIC (#3 resolver-exit) — remove after root cause.
  // Capture-only: failure to log must not affect dispatch, claim, comment, or
  // workflow behavior.
  try {
    ctx.log?.("info", `resolver-exit diagnostic: ${message}`, {
      diag: "cloud-small-issue-codex-resolver-exit",
      temporary: true,
      ...redactResolverDiagnosticValue(fields) as Record<string, unknown>,
    });
  } catch {
    // best effort only
  }
}

function redactResolverDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_GH_TOKEN]")
      .replace(/x-access-token:[^@\s/'"]+/gi, "x-access-token:[REDACTED]")
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s'"]+/gi, "$1[REDACTED]")
      .replace(/("?(?:api[_-]?key|token|secret)"?\s*[:=]\s*")([^"]+)(")/gi, "$1[REDACTED]$3");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactResolverDiagnosticValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, redactResolverDiagnosticValue(entry)]),
    );
  }
  return value;
}

async function writeThreadState(ctx: any, threadTs: string, state: IssueState): Promise<void> {
  const body = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  await ctx.files.write(`${STATE_ROOT}/threads/${safeName(threadTs)}.json`, body);
  await ctx.files.write(`${STATE_ROOT}/by-issue/${state.issueNumber}.json`, body);
}

async function readThreadState(ctx: any, threadTs: string): Promise<IssueState | null> {
  try {
    return JSON.parse(await ctx.files.read(`${STATE_ROOT}/threads/${safeName(threadTs)}.json`)) as IssueState;
  } catch {
    return null;
  }
}

async function fileExists(ctx: any, path: string): Promise<boolean> {
  try {
    await ctx.files.read(path);
    return true;
  } catch {
    return false;
  }
}

export function workflowSource(issue: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  archiveLeaseMaterializeEnabled?: boolean;
}): string {
  return `
import { workflow } from '@relayflows/core';

const ISSUE_NUMBER = ${JSON.stringify(String(issue.issueNumber))};
const ISSUE_TITLE = ${JSON.stringify(issue.issueTitle)};
const ISSUE_BODY = ${JSON.stringify(issue.issueBody)};
const ISSUE_URL = ${JSON.stringify(issue.issueUrl)};
const REPO = 'AgentWorkforce/cloud';
const REPO_DIR = './cloud';
const BRANCH = 'codex/small-issue-' + ISSUE_NUMBER;
const PR_TITLE = 'Fix small issue #' + ISSUE_NUMBER;
const PR_BODY = 'Fixes #' + ISSUE_NUMBER + '. Implemented by cloud-small-issue-codex.';
${renderMaterializeScriptSource({
  archiveLeaseMaterializeEnabled: issue.archiveLeaseMaterializeEnabled,
  config: ISSUE_RESOLVER_MATERIALIZE_SCRIPT_CONFIG,
})}
${renderCreateProxyPrScriptSource("cloud-small-issue-codex")}
${renderScriptRuntimeSource()}
await workflow('cloud-small-issue-' + ISSUE_NUMBER)
  .description('Auto-fix small cloud issue #' + ISSUE_NUMBER)
  .pattern('dag')
  .timeout(4_500_000)
  .agent('impl', { cli: 'codex', preset: 'worker', role: 'Implement the minimal fix in the materialized working tree.', retries: 1, maxTokens: 32000 })
  .step('preflight', {
    type: 'deterministic',
    command: [
      'set -e',
      writeNodeScriptCommand(MATERIALIZE_SCRIPT_B64, '/tmp/cloud-small-issue-materialize.cjs'),
      'node ' + [
        '/tmp/cloud-small-issue-materialize.cjs',
        'AgentWorkforce',
        'cloud',
        REPO_DIR
      ].map(shellQuote).join(' ')
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 900000,
  })
  .step('implement', {
    agent: 'impl',
    dependsOn: ['preflight'],
    task: [
      'Work in ' + REPO_DIR + ' on branch ' + BRANCH + '.',
      'GitHub issue #' + ISSUE_NUMBER + ' on AgentWorkforce/cloud: ' + ISSUE_TITLE,
      'URL: ' + ISSUE_URL,
      'Issue body (the task you must perform — read it carefully):\\n' + ISSUE_BODY,
      'STRICT CONSTRAINTS — follow exactly:\\n' +
        '- Perform ONLY the change the issue body asks for. Do nothing else.\\n' +
        '- If the issue body names specific files to edit, edit ONLY those files. Do NOT modify any other file for any reason — not for refactors, not for cleanups, not for tangential improvements, not for "while I am here" changes.\\n' +
        '- Do NOT add tests, comments, documentation, or formatting changes unless the issue body explicitly asks for them.\\n' +
        '- If the requested change is small (for example: append one line to a single file), make exactly that change and stop.\\n' +
        '- Do NOT modify files outside the scope the issue defines, even if you notice unrelated issues in passing.',
      'Do NOT commit, push, or open a PR; the final step collects the working-tree diff and opens the PR through Cloud.'
    ].join('\\n\\n'),
    verification: { type: 'exit_code' },
    timeoutMs: 1_800_000,
    retries: 1,
  })
  .step('open-pr', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: [
      'set -e',
      writeNodeScriptCommand(CREATE_PROXY_PR_SCRIPT_B64, '/tmp/cloud-small-issue-create-pr.cjs'),
      'node ' + [
        '/tmp/cloud-small-issue-create-pr.cjs',
        REPO_DIR,
        'AgentWorkforce',
        'cloud',
        BRANCH,
        PR_TITLE,
        PR_BODY
      ].map(shellQuote).join(' ')
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 300000,
  })
  .run();
`;
}

function parseWorkflowOutput(output: unknown): Partial<IssueState> {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const prUrl =
    text.match(/https:\/\/github\.com\/AgentWorkforce\/cloud\/pull\/\d+/)?.[0] ??
    text.match(/http:\/\/localhost:3000\/cloud\/dev\/github\/pull-request\/[A-Za-z0-9%._~/-]+/)?.[0];
  return {
    prUrl,
    branch: text.match(/codex\/small-issue-[A-Za-z0-9._/-]+/)?.[0],
  };
}

function summarizeWorkflowOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function maybeRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function readLabels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(asRecord(entry).name ?? entry).toLowerCase())
    : [];
}

function escapeSlack(value: string): string {
  return value.replace(/[<>&]/g, (ch) => ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "&amp;");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
