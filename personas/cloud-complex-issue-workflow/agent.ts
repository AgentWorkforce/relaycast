import { defineAgent, draftFile, encodeSegment, writeJsonFile } from "@agentworkforce/runtime";
import {
  claimIssueDispatch as claimIssueDispatchShared,
  releaseIssueDispatchClaim as releaseIssueDispatchClaimShared,
  renderCreateProxyPrScriptSource,
  renderMaterializeScriptSource,
  renderScriptRuntimeSource,
  type IssueDispatchClaim,
  type IssueDispatchClaimConfig,
  type IssueDispatchClaimResult,
} from "../_shared/issue-resolver";
// NOTE: the embedded materialize/PR scripts below are intentionally kept in
// lockstep with cloud-complex-issue-workflow (proven clone + proxy-PR plumbing). The
// distinct value of this persona is the MULTI-AGENT workflow shape (planner →
// impl → reviewer → bounded repair → open-pr) authored in workflowSource().

const REPO_OWNER = "AgentWorkforce";
const REPO_NAME = "cloud";
const REPO_FULL_NAME = `${REPO_OWNER}/${REPO_NAME}`;
const LABEL = "complex";
const DEFAULT_SLACK_CHANNEL = "proj-cloud";
const STATE_ROOT = "_agents/cloud-complex-issue-workflow";
const WORKFLOW_NAME = "cloud-complex-issue-workflow";
const DISPATCH_CLAIM_ROOT = "/github/_agents/cloud-complex-issue-workflow/dispatch-claims";
const RELAYFILE_CORRELATION_ID = "cloud-complex-issue-workflow";
const DISPATCH_CLAIM_TIMEOUT_MS = 10_000;
const DISPATCH_CLAIM_MAX_ATTEMPTS = 3;
const DISPATCH_CLAIM_RETRY_BACKOFF_MS = 500;
const ARCHIVE_LEASE_MATERIALIZE_FLAG =
  "CLOUD_COMPLEX_ISSUE_ARCHIVE_LEASE_MATERIALIZE_ENABLED";

const ISSUE_RESOLVER_MATERIALIZE_SCRIPT_CONFIG = {
  personaId: WORKFLOW_NAME,
  relayfileCorrelationId: RELAYFILE_CORRELATION_ID,
  tempPrefix: "cloud-complex-issue-",
  localTempPrefix: "cloud-complex-issue-local-",
  archiveTempPrefix: "cloud-complex-issue-archive-",
  gitUserEmail: "cloud-complex-issue-workflow@agentworkforce.local",
  gitUserName: "cloud-complex-issue-workflow",
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
    ctx.log("info", "skipping issue without complex label", { labels, eventId: event.id });
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
      "I will run the multi-stage complex-issue workflow (plan → implement → review → open-pr) and post the PR back here.",
    );

    // Only the durable-claim path is idempotent; fail-open paths still dispatch
    // work, but must not post the duplicate-prone GitHub claim comment.
    if (claim.claim) {
      await commentIssue(ctx, issueNumber,
        `Proactive agent \`cloud-complex-issue-workflow\` picked this up. ` +
        `Workflow dispatch is starting; Slack thread: #${channel}${handoff?.ts ? ` (${handoff.ts})` : ""}.`,
      );
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
        // Dispatch-level gate: only a `complex` label wakes this persona
        // (see cloud-small-issue-codex for the rationale).
        where: "label.name=complex",
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
  // Listen on the SAME channel the handoff is posted to (see line ~88). The
  // configured channel can be overridden via persona input; comparing against
  // a hardcoded constant would silently ignore follow-up questions whenever
  // SLACK_CHANNEL is customized.
  const configuredChannel = String(ctx.persona?.inputs?.SLACK_CHANNEL || DEFAULT_SLACK_CHANNEL);
  const channel = stringValue(event.channel) ?? stringValue(payload.channel) ?? configuredChannel;
  if (channel !== configuredChannel) return;
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

async function commentIssue(ctx: any, number: number, body: string): Promise<void> {
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
  } catch (error) {
    // Warn instead of dropping observability silently, but never let comment delivery break the claim flow.
    ctx.log?.("warn", "github VFS comment failed; comment dropped", {
      issueNumber: number,
      bodyPreview: body.slice(0, 120),
      error: errMsg(error),
    });
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
const BRANCH = 'codex/complex-issue-' + ISSUE_NUMBER;
const PR_TITLE = 'Resolve complex issue #' + ISSUE_NUMBER;
const PR_BODY = 'Resolves #' + ISSUE_NUMBER + '. Implemented by the cloud-complex-issue-workflow multi-stage path.';
${renderMaterializeScriptSource({
  archiveLeaseMaterializeEnabled: issue.archiveLeaseMaterializeEnabled,
  config: ISSUE_RESOLVER_MATERIALIZE_SCRIPT_CONFIG,
})}
${renderCreateProxyPrScriptSource("cloud-complex-issue-workflow")}
${renderScriptRuntimeSource()}
await workflow('cloud-complex-issue-' + ISSUE_NUMBER)
  .description('Multi-stage resolution for complex cloud issue #' + ISSUE_NUMBER)
  .pattern('dag')
  .timeout(5_400_000)
  .agent('planner', { cli: 'claude', preset: 'worker', role: 'Produce a concrete implementation plan for the issue.', retries: 1, maxTokens: 32000 })
  .agent('impl', { cli: 'codex', preset: 'worker', role: 'Implement the planned change in the materialized working tree.', retries: 1, maxTokens: 32000 })
  .agent('reviewer', { cli: 'claude', preset: 'worker', role: 'Review the implementation diff against the plan and the issue.', retries: 1, maxTokens: 32000 })
  .step('preflight', {
    type: 'deterministic',
    command: [
      'set -e',
      writeNodeScriptCommand(MATERIALIZE_SCRIPT_B64, '/tmp/cloud-complex-issue-materialize.cjs'),
      'node ' + [
        '/tmp/cloud-complex-issue-materialize.cjs',
        'AgentWorkforce',
        'cloud',
        REPO_DIR
      ].map(shellQuote).join(' ')
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
    timeoutMs: 900000,
  })
  .step('plan', {
    agent: 'planner',
    dependsOn: ['preflight'],
    task: [
      'Work in ' + REPO_DIR + ' for GitHub issue #' + ISSUE_NUMBER + ' on AgentWorkforce/cloud: ' + ISSUE_TITLE,
      'URL: ' + ISSUE_URL,
      'Issue body (read carefully):\\n' + ISSUE_BODY,
      'PLAN STAGE — produce a concrete implementation plan. Write it to ' + REPO_DIR + '/PLAN.md as Markdown containing: (1) the exact files you will change, (2) the approach per file, (3) validation/test notes.',
      'STRICT: In this stage create ONLY ' + REPO_DIR + '/PLAN.md. Do NOT modify, create, or delete any other file. Do NOT commit, push, or open a PR.'
    ].join('\\n\\n'),
    verification: { type: 'exit_code' },
    timeoutMs: 1_200_000,
    retries: 1,
  })
  .step('implement', {
    agent: 'impl',
    dependsOn: ['plan'],
    task: [
      'Work in ' + REPO_DIR + ' on branch ' + BRANCH + '.',
      'GitHub issue #' + ISSUE_NUMBER + ' on AgentWorkforce/cloud: ' + ISSUE_TITLE,
      'URL: ' + ISSUE_URL,
      'IMPLEMENT STAGE — read the plan at ' + REPO_DIR + '/PLAN.md and implement it.',
      'Issue body (the task you must perform):\\n' + ISSUE_BODY,
      'STRICT CONSTRAINTS — follow exactly:\\n' +
        '- Implement what the plan and the issue body require, across the files the plan names.\\n' +
        '- Do NOT make unrelated refactors, cleanups, or "while I am here" changes.\\n' +
        '- Do NOT delete ' + REPO_DIR + '/PLAN.md.\\n' +
        '- Do NOT add tests, comments, or documentation unless the issue or plan asks for them.',
      'Do NOT commit, push, or open a PR; later stages collect the working-tree diff and open the PR through Cloud.'
    ].join('\\n\\n'),
    verification: { type: 'exit_code' },
    timeoutMs: 1_800_000,
    retries: 1,
  })
  .step('review', {
    agent: 'reviewer',
    dependsOn: ['implement'],
    task: [
      'Work in ' + REPO_DIR + '. REVIEW STAGE for GitHub issue #' + ISSUE_NUMBER + ': ' + ISSUE_TITLE,
      'Inspect the implementation: run "git -C ' + REPO_DIR + ' status" and "git -C ' + REPO_DIR + ' diff", and read ' + REPO_DIR + '/PLAN.md.',
      'Issue body:\\n' + ISSUE_BODY,
      'Write your review to ' + REPO_DIR + '/REVIEW.md. The FIRST line MUST be EXACTLY "VERDICT: APPROVE" or "VERDICT: REQUEST_CHANGES". Follow it with concrete, actionable findings on correctness, scope, and anything missing relative to the plan and the issue.',
      'STRICT: modify ONLY ' + REPO_DIR + '/REVIEW.md. Do NOT change source files. Do NOT commit, push, or open a PR.'
    ].join('\\n\\n'),
    verification: { type: 'exit_code' },
    timeoutMs: 1_200_000,
    retries: 1,
  })
  .step('implement-repair', {
    agent: 'impl',
    dependsOn: ['review'],
    task: [
      'Work in ' + REPO_DIR + ' on branch ' + BRANCH + '.',
      'REPAIR STAGE (single bounded pass) for issue #' + ISSUE_NUMBER + '.',
      'Read ' + REPO_DIR + '/REVIEW.md. If its first line is "VERDICT: APPROVE", make NO changes and exit 0.',
      'If its first line is "VERDICT: REQUEST_CHANGES", apply the requested fixes to the source files in a single pass.',
      'STRICT: Do NOT modify ' + REPO_DIR + '/PLAN.md or ' + REPO_DIR + '/REVIEW.md. Do NOT commit, push, or open a PR.'
    ].join('\\n\\n'),
    verification: { type: 'exit_code' },
    timeoutMs: 1_800_000,
    retries: 0,
  })
  .step('open-pr', {
    type: 'deterministic',
    dependsOn: ['implement-repair'],
    command: [
      'set -e',
      writeNodeScriptCommand(CREATE_PROXY_PR_SCRIPT_B64, '/tmp/cloud-complex-issue-create-pr.cjs'),
      'node ' + [
        '/tmp/cloud-complex-issue-create-pr.cjs',
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
    branch: text.match(/codex\/complex-issue-[A-Za-z0-9._/-]+/)?.[0],
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
