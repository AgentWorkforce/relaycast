import { createHmac, timingSafeEqual } from "node:crypto";
import type { GateResolution, RickyRunStatus } from "./types";

export type RickySlackInstallationStatus = "active" | "disabled" | "revoked";
export type RickySlackUserLinkStatus = "active" | "revoked";
export type RickySlackMembershipRole = "member" | "admin" | "owner";

export type RickySlackInstallation = {
  id: string;
  organizationId: string;
  workspaceId: string;
  slackTeamId: string;
  status: RickySlackInstallationStatus;
  connectionId?: string | null;
};

export type RickySlackUserLink = {
  id: string;
  organizationId: string;
  workspaceId: string;
  cloudUserId: string;
  slackTeamId: string;
  slackUserId: string;
  status: RickySlackUserLinkStatus;
};

export type RickySlackWorkspaceMembership = {
  organizationId: string;
  workspaceId: string;
  cloudUserId: string;
  role: RickySlackMembershipRole;
  status: "active" | "inactive" | "revoked";
};

export type RickySlackActor = {
  organizationId: string;
  workspaceId: string;
  cloudUserId: string;
  slackTeamId: string;
  slackUserId: string;
  role: RickySlackMembershipRole;
  isWorkspaceAdmin: boolean;
};

export type RickySlackResolveFailureReason =
  | "missing_installation"
  | "installation_revoked"
  | "missing_link"
  | "link_revoked"
  | "missing_membership";

export type RickySlackResolveResult =
  | { ok: true; actor: RickySlackActor; installation: RickySlackInstallation }
  | { ok: false; reason: RickySlackResolveFailureReason; workspaceId?: string; organizationId?: string };

export type RickySlashCommand =
  | { type: "run"; workflowRef: string }
  | { type: "status"; rickyRunId?: string }
  | { type: "approve"; gateId: string }
  | { type: "deny"; gateId: string }
  | { type: "connect" }
  | { type: "help" }
  | { type: "unknown"; reason: string };

export type RickySlackActionType =
  | "connect_cloud"
  | "start_workflow"
  | "read_run_status"
  | "read_run_logs"
  | "approve_gate"
  | "deny_gate"
  | "edit_gate"
  | "retry_run"
  | "cancel_run";

export type RickySlackGateAccess = {
  id: string;
  rickyRunId: string;
  workspaceId: string;
  status: "open" | "approved" | "denied" | "edited" | "expired" | "canceled";
  eligibleApproverCloudUserIds?: string[];
};

export type RickyGateActionPayload = {
  action: "approve" | "deny" | "edit";
  rickyRunId: string;
  gateId: string;
  workspaceId: string;
  slackTeamId: string;
  slackUserId: string;
  channelId: string;
  messageTs: string;
  instruction?: string;
};

export type RickySlackEgressInput = {
  workspaceId: string;
  channel: string;
  text: string;
  threadTs?: string;
  blocks?: unknown[];
  user?: string;
};

export type RickySlackEgressResult = {
  ok: boolean;
  ts?: string;
  error?: string;
};

export type RickySlackThread = {
  rickyRunId: string;
  workspaceId: string;
  slackTeamId: string;
  channelId: string;
  threadTs: string;
  status: "active" | "muted" | "archived";
};

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

function toBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = toBuffer(left);
  const rightBuffer = toBuffer(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function signSlackRequest(input: {
  signingSecret: string;
  timestamp: number;
  body: string;
}): string {
  const base = `v0:${input.timestamp}:${input.body}`;
  const digest = createHmac("sha256", input.signingSecret).update(base).digest("hex");
  return `v0=${digest}`;
}

export function verifySlackRequestSignature(input: {
  signingSecret: string;
  timestamp: string | number | null | undefined;
  signature: string | null | undefined;
  body: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: "missing" | "stale" | "invalid" } {
  if (!input.timestamp || !input.signature) {
    return { ok: false, reason: "missing" };
  }

  const timestamp = Number(input.timestamp);
  if (!Number.isInteger(timestamp)) {
    return { ok: false, reason: "invalid" };
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) {
    return { ok: false, reason: "stale" };
  }

  const expected = signSlackRequest({
    signingSecret: input.signingSecret,
    timestamp,
    body: input.body,
  });
  return constantTimeEqual(expected, input.signature) ? { ok: true } : { ok: false, reason: "invalid" };
}

// TODO(ricky-slack): Replace with a shared idempotency store (DB/Redis with TTL
// or unique constraint claim) once Ricky Slack runs across multiple worker
// instances. Today this is process-local; in scaled deploys a single Slack
// retry can hit a different instance and process the callback twice.
export class InMemoryRickySlackDedupStore {
  private readonly keys = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  checkAndStore(key: string, nowMs: number = Date.now()): "accepted" | "duplicate" {
    this.prune(nowMs);
    const existing = this.keys.get(key);
    if (existing !== undefined && existing > nowMs) {
      return "duplicate";
    }
    this.keys.set(key, nowMs + this.ttlMs);
    return "accepted";
  }

  private prune(nowMs: number): void {
    for (const [key, expiresAt] of this.keys) {
      if (expiresAt <= nowMs) {
        this.keys.delete(key);
      }
    }
  }
}

export function parseRickySlashCommand(text: string): RickySlashCommand {
  const normalized = text.trim().replace(/^\/ricky(?:\s+|$)/i, "").trim();
  if (!normalized) {
    return { type: "help" };
  }

  const [command = "", ...restParts] = normalized.split(/\s+/);
  const rest = restParts.join(" ").trim();
  switch (command.toLowerCase()) {
    case "run":
      return rest ? { type: "run", workflowRef: rest } : { type: "unknown", reason: "missing_workflow_ref" };
    case "status":
      return rest ? { type: "status", rickyRunId: rest } : { type: "status" };
    case "approve":
      return rest ? { type: "approve", gateId: rest } : { type: "unknown", reason: "missing_gate_id" };
    case "deny":
      return rest ? { type: "deny", gateId: rest } : { type: "unknown", reason: "missing_gate_id" };
    case "connect":
      return { type: "connect" };
    case "help":
      return { type: "help" };
    default:
      return { type: "unknown", reason: "unknown_command" };
  }
}

export function resolveRickySlackActor(input: {
  slackTeamId: string;
  slackUserId: string;
  installations: readonly RickySlackInstallation[];
  userLinks: readonly RickySlackUserLink[];
  memberships: readonly RickySlackWorkspaceMembership[];
}): RickySlackResolveResult {
  const installation = input.installations.find((item) => item.slackTeamId === input.slackTeamId);
  if (!installation) {
    return { ok: false, reason: "missing_installation" };
  }
  if (installation.status !== "active") {
    return {
      ok: false,
      reason: "installation_revoked",
      workspaceId: installation.workspaceId,
      organizationId: installation.organizationId,
    };
  }

  const link = input.userLinks.find(
    (item) =>
      item.slackTeamId === input.slackTeamId &&
      item.slackUserId === input.slackUserId &&
      item.workspaceId === installation.workspaceId &&
      item.organizationId === installation.organizationId,
  );
  if (!link) {
    return {
      ok: false,
      reason: "missing_link",
      workspaceId: installation.workspaceId,
      organizationId: installation.organizationId,
    };
  }
  if (link.status !== "active") {
    return {
      ok: false,
      reason: "link_revoked",
      workspaceId: installation.workspaceId,
      organizationId: installation.organizationId,
    };
  }

  const membership = input.memberships.find(
    (item) =>
      item.organizationId === installation.organizationId &&
      item.workspaceId === installation.workspaceId &&
      item.cloudUserId === link.cloudUserId &&
      item.status === "active",
  );
  if (!membership) {
    return {
      ok: false,
      reason: "missing_membership",
      workspaceId: installation.workspaceId,
      organizationId: installation.organizationId,
    };
  }

  return {
    ok: true,
    installation,
    actor: {
      organizationId: installation.organizationId,
      workspaceId: installation.workspaceId,
      cloudUserId: link.cloudUserId,
      slackTeamId: input.slackTeamId,
      slackUserId: input.slackUserId,
      role: membership.role,
      isWorkspaceAdmin: membership.role === "admin" || membership.role === "owner",
    },
  };
}

export function authorizeRickySlackAction(input: {
  action: RickySlackActionType;
  actor: RickySlackActor;
  gate?: RickySlackGateAccess | null;
  runOwnerCloudUserId?: string | null;
}): { allowed: true } | { allowed: false; reason: "workspace_mismatch" | "gate_not_open" | "not_gate_approver" } {
  if (input.action === "approve_gate" || input.action === "deny_gate" || input.action === "edit_gate") {
    const gate = input.gate;
    if (!gate || gate.workspaceId !== input.actor.workspaceId) {
      return { allowed: false, reason: "workspace_mismatch" };
    }
    if (gate.status !== "open") {
      return { allowed: false, reason: "gate_not_open" };
    }
    const eligible = gate.eligibleApproverCloudUserIds ?? [];
    if (
      input.actor.isWorkspaceAdmin ||
      input.runOwnerCloudUserId === input.actor.cloudUserId ||
      eligible.includes(input.actor.cloudUserId)
    ) {
      return { allowed: true };
    }
    return { allowed: false, reason: "not_gate_approver" };
  }

  return { allowed: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseRickyGateActionPayload(value: string): RickyGateActionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const action = parsed.action;
  if (action !== "approve" && action !== "deny" && action !== "edit") {
    return null;
  }

  const payload = {
    action,
    rickyRunId: requiredString(parsed, "rickyRunId"),
    gateId: requiredString(parsed, "gateId"),
    workspaceId: requiredString(parsed, "workspaceId"),
    slackTeamId: requiredString(parsed, "slackTeamId"),
    slackUserId: requiredString(parsed, "slackUserId"),
    channelId: requiredString(parsed, "channelId"),
    messageTs: requiredString(parsed, "messageTs"),
    instruction: typeof parsed.instruction === "string" ? parsed.instruction.trim() : undefined,
  };

  if (
    !payload.rickyRunId ||
    !payload.gateId ||
    !payload.workspaceId ||
    !payload.slackTeamId ||
    !payload.slackUserId ||
    !payload.channelId ||
    !payload.messageTs
  ) {
    return null;
  }
  if (payload.action === "edit" && !payload.instruction) {
    return null;
  }

  return payload as RickyGateActionPayload;
}

export function mapGatePayloadToResolution(payload: RickyGateActionPayload): {
  rickyRunId: string;
  gateId: string;
  workspaceId: string;
  resolution: GateResolution;
  audit: {
    slackTeamId: string;
    slackUserId: string;
    channelId: string;
    messageTs: string;
  };
} {
  const resolution: GateResolution =
    payload.action === "edit"
      ? { decision: "edit", instruction: payload.instruction ?? "" }
      : { decision: payload.action };

  return {
    rickyRunId: payload.rickyRunId,
    gateId: payload.gateId,
    workspaceId: payload.workspaceId,
    resolution,
    audit: {
      slackTeamId: payload.slackTeamId,
      slackUserId: payload.slackUserId,
      channelId: payload.channelId,
      messageTs: payload.messageTs,
    },
  };
}

export function mapBlockKitGateActionToResolution(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.actions) || !isRecord(body.actions[0])) {
    return null;
  }
  const value = body.actions[0].value;
  if (typeof value !== "string") {
    return null;
  }
  const payload = parseRickyGateActionPayload(value);
  return payload ? mapGatePayloadToResolution(payload) : null;
}

export function buildConnectPrompt(input: { workspaceId?: string; slackUserId: string }): string {
  const workspaceHint = input.workspaceId ? ` for workspace ${input.workspaceId}` : "";
  return `<@${input.slackUserId}> connect your Cloud account${workspaceHint}: /ricky connect`;
}

export function createRickySlackEgress(input: {
  installations: readonly RickySlackInstallation[];
  sink: (message: RickySlackEgressInput) => Promise<RickySlackEgressResult> | RickySlackEgressResult;
}) {
  async function send(message: RickySlackEgressInput): Promise<RickySlackEgressResult> {
    const installation = input.installations.find((item) => item.workspaceId === message.workspaceId);
    if (!installation || installation.status !== "active") {
      return { ok: false, error: "installation_revoked" };
    }
    return input.sink(message);
  }

  return {
    postMessage: send,
    updateMessage: send,
    postEphemeral: send,
  };
}

export async function postTerminalRunTransition(input: {
  rickyRunId: string;
  status: RickyRunStatus;
  thread: RickySlackThread | null;
  egress: { postMessage(message: RickySlackEgressInput): Promise<RickySlackEgressResult> };
}): Promise<RickySlackEgressResult | null> {
  if (!input.thread || input.thread.status !== "active") {
    return null;
  }

  const terminalText: Partial<Record<RickyRunStatus, string>> = {
    succeeded: `Ricky run ${input.rickyRunId} succeeded.`,
    failed: `Ricky run ${input.rickyRunId} failed.`,
    exhausted: `Ricky run ${input.rickyRunId} exhausted repair attempts.`,
  };
  const text = terminalText[input.status];
  if (!text) {
    return null;
  }

  return input.egress.postMessage({
    workspaceId: input.thread.workspaceId,
    channel: input.thread.channelId,
    threadTs: input.thread.threadTs,
    text,
  });
}

export async function handleRickySlackCommand(input: {
  text: string;
  slackTeamId: string;
  slackUserId: string;
  channelId: string;
  triggerId: string;
  dedup: InMemoryRickySlackDedupStore;
  resolveActor: () => RickySlackResolveResult;
  launchRun: (actor: RickySlackActor, workflowRef: string) => Promise<{ rickyRunId: string }>;
  postEphemeral: (message: RickySlackEgressInput) => Promise<RickySlackEgressResult>;
}): Promise<
  | { type: "deduped" }
  | { type: "connect_prompt"; result: RickySlackEgressResult }
  | { type: "run_started"; rickyRunId: string }
  | { type: "parsed"; command: RickySlashCommand }
> {
  const dedupKey = `command:${input.slackTeamId}:${input.triggerId}`;
  if (input.dedup.checkAndStore(dedupKey) === "duplicate") {
    return { type: "deduped" };
  }

  const command = parseRickySlashCommand(input.text);
  if (command.type === "connect") {
    const result = await input.postEphemeral({
      workspaceId: "unresolved",
      channel: input.channelId,
      user: input.slackUserId,
      text: buildConnectPrompt({ slackUserId: input.slackUserId }),
    });
    return { type: "connect_prompt", result };
  }

  const resolved = input.resolveActor();
  if (!resolved.ok) {
    const result = await input.postEphemeral({
      workspaceId: resolved.workspaceId ?? "unresolved",
      channel: input.channelId,
      user: input.slackUserId,
      text: buildConnectPrompt({ workspaceId: resolved.workspaceId, slackUserId: input.slackUserId }),
    });
    return { type: "connect_prompt", result };
  }

  if (command.type === "run") {
    const run = await input.launchRun(resolved.actor, command.workflowRef);
    return { type: "run_started", rickyRunId: run.rickyRunId };
  }

  return { type: "parsed", command };
}

export async function handleRickySlackEvent(input: {
  eventId: string;
  slackTeamId: string;
  slackUserId: string;
  text: string;
  dedup: InMemoryRickySlackDedupStore;
  resolveActor: () => RickySlackResolveResult;
  launchRun: (actor: RickySlackActor, workflowRef: string) => Promise<{ rickyRunId: string }>;
}): Promise<{ type: "deduped" } | { type: "ignored" } | { type: "run_started"; rickyRunId: string }> {
  const dedupKey = `event:${input.slackTeamId}:${input.eventId}`;
  if (input.dedup.checkAndStore(dedupKey) === "duplicate") {
    return { type: "deduped" };
  }

  const commandText = input.text.replace(/^<@[^>]+>\s*/, "").trim();
  const command = parseRickySlashCommand(commandText);
  if (command.type !== "run") {
    return { type: "ignored" };
  }

  const resolved = input.resolveActor();
  if (!resolved.ok) {
    return { type: "ignored" };
  }

  const run = await input.launchRun(resolved.actor, command.workflowRef);
  return { type: "run_started", rickyRunId: run.rickyRunId };
}

export async function handleRickySlackInteractivity(input: {
  body: unknown;
  resolveActor: (payload: RickyGateActionPayload) => RickySlackResolveResult;
  gate: RickySlackGateAccess;
  resolveGate: (input: {
    rickyRunId: string;
    gateId: string;
    cloudUserId: string;
    resolution: GateResolution;
  }) => Promise<unknown>;
  resumeSupervisor: (input: {
    rickyRunId: string;
    gateId: string;
    actor: RickySlackActor;
    resolution: GateResolution;
  }) => Promise<unknown>;
}): Promise<
  | { type: "invalid_payload" }
  | { type: "connect_required"; reason: RickySlackResolveFailureReason }
  | { type: "unauthorized"; reason: string }
  | { type: "resolved"; resolution: GateResolution }
> {
  if (!isRecord(input.body) || !Array.isArray(input.body.actions) || !isRecord(input.body.actions[0])) {
    return { type: "invalid_payload" };
  }
  const rawPayload = input.body.actions[0].value;
  if (typeof rawPayload !== "string") {
    return { type: "invalid_payload" };
  }
  const payload = parseRickyGateActionPayload(rawPayload);
  if (!payload) {
    return { type: "invalid_payload" };
  }

  if (input.gate.id !== payload.gateId || input.gate.rickyRunId !== payload.rickyRunId) {
    return { type: "invalid_payload" };
  }

  // TODO(ricky-slack): Dedup interactivity callbacks by Slack request id so a
  // retried button click does not double-resolve a gate or double-resume the
  // supervisor. Current command and event paths are deduped; the interactivity
  // path is not.

  const actorResult = input.resolveActor(payload);
  if (!actorResult.ok) {
    return { type: "connect_required", reason: actorResult.reason };
  }

  const resolution = mapGatePayloadToResolution(payload).resolution;
  const policyAction =
    resolution.decision === "approve"
      ? "approve_gate"
      : resolution.decision === "deny"
        ? "deny_gate"
        : "edit_gate";
  const policy = authorizeRickySlackAction({
    action: policyAction,
    actor: actorResult.actor,
    gate: input.gate,
  });
  if (!policy.allowed) {
    return { type: "unauthorized", reason: policy.reason };
  }

  await input.resolveGate({
    rickyRunId: payload.rickyRunId,
    gateId: payload.gateId,
    cloudUserId: actorResult.actor.cloudUserId,
    resolution,
  });

  if (resolution.decision === "approve" || resolution.decision === "edit") {
    await input.resumeSupervisor({
      rickyRunId: payload.rickyRunId,
      gateId: payload.gateId,
      actor: actorResult.actor,
      resolution,
    });
  }

  return { type: "resolved", resolution };
}
