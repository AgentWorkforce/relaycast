import crypto from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { nodeEnrollmentTokens, workspaces } from "@/lib/db/schema";
import { getRelayWorkspace } from "@/lib/relay-workspaces";
import {
  ensureRelaycastApiKeyForRelayWorkspace,
  resolveOrProvisionRelayWorkspace,
} from "@/lib/workflows/relay-workspace";
import { resolveRelaycastUrl } from "@/lib/workspace-registry";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const NODE_ENROLLMENT_TOKEN_PREFIX = "ocl_node_enr_";
// A claim that is held longer than this without being burned (usedAt) is treated
// as abandoned — the redeemer crashed between claiming and minting/burning — and
// may be re-claimed. Without this, a crash mid-mint would brick the token
// permanently because the claim CAS keys on claimNonce IS NULL, not on expiry.
const CLAIM_STALE_MS = 2 * 60 * 1000;

export type FleetNode = {
  id: string;
  name: string;
  capabilities: Array<string | { name: string; kind?: string; metadata?: Record<string, unknown> }>;
  tags: string[];
  version: string;
  status: "online" | "offline" | string;
  live: boolean;
  handlers_live: boolean;
  load: number;
  active_agents: number;
  max_agents: number;
  last_heartbeat_at: string | null;
  created_at: string;
};

export type FleetNodeEnrollmentDefaults = {
  name?: string;
  capabilities?: string[];
  maxAgents?: number;
  tags?: string[];
};

function encodeBase58(length: number): string {
  let value = "";
  while (value.length < length) {
    const bytes = crypto.randomBytes(length);
    for (const byte of bytes) {
      if (value.length >= length) break;
      if (byte < 232) value += BASE58_ALPHABET[byte % BASE58_ALPHABET.length];
    }
  }
  return value;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeMaxAgents(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function postRelaycastNode(input: {
  relaycastUrl: string;
  apiKey: string;
  nodeName: string;
  capabilities: string[];
  maxAgents: number;
  tags: string[];
  version?: string;
}): Promise<{
  response: Response;
  payload: { ok?: boolean; data?: { id?: string; name?: string; token?: string } } | null;
}> {
  const response = await fetch(`${input.relaycastUrl}/v1/nodes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: input.nodeName,
      capabilities: input.capabilities,
      max_agents: input.maxAgents,
      tags: input.tags,
      version: input.version?.trim() || "cloud-enrolled",
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; data?: { id?: string; name?: string; token?: string } }
    | null;
  return { response, payload };
}

async function resolveRelayWorkspaceAfterUnauthorized(input: {
  userId: string;
  appWorkspaceId: string;
  failedRelayWorkspaceId: string;
}): Promise<{
  id: string;
  relaycastApiKey: string;
}> {
  const current = await resolveOrProvisionRelayWorkspace({
    userId: input.userId,
    appWorkspaceId: input.appWorkspaceId,
  });
  if (current.id !== input.failedRelayWorkspaceId && current.relaycastApiKey?.trim()) {
    return current;
  }

  return ensureRelaycastApiKeyForRelayWorkspace({
    relayWorkspaceId: input.failedRelayWorkspaceId,
  });
}

export function buildFleetEnrollCommand(input: {
  enrollmentToken: string;
  enrollmentUrl: string;
  name?: string;
}): string {
  const parts = [
    "agent-relay",
    "fleet",
    "serve",
    "--enrollment-token",
    shellArg(input.enrollmentToken),
    "--enrollment-url",
    shellArg(input.enrollmentUrl),
  ];
  if (input.name) {
    parts.push("--name", shellArg(input.name));
  }
  return parts.join(" ");
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function mintNodeEnrollmentToken(input: {
  workspaceId: string;
  userId: string;
  workspaceName?: string;
  defaults?: FleetNodeEnrollmentDefaults;
}): Promise<{
  plaintext: string;
  expiresAt: Date;
  relayWorkspaceId: string;
}> {
  const relayWorkspace = await resolveOrProvisionRelayWorkspace({
    userId: input.userId,
    appWorkspaceId: input.workspaceId,
    name: input.workspaceName,
  });
  const plaintext = `${NODE_ENROLLMENT_TOKEN_PREFIX}${encodeBase58(28)}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const defaults = input.defaults ?? {};

  await getDb().insert(nodeEnrollmentTokens).values({
    tokenHash: hashToken(plaintext),
    workspaceId: input.workspaceId,
    relayWorkspaceId: relayWorkspace.id,
    requestedName: defaults.name?.trim() || null,
    capabilities: normalizeStringList(defaults.capabilities),
    maxAgents: normalizeMaxAgents(defaults.maxAgents),
    tags: normalizeStringList(defaults.tags),
    createdBy: input.userId,
    expiresAt,
  });

  return {
    plaintext,
    expiresAt,
    relayWorkspaceId: relayWorkspace.id,
  };
}

export async function redeemNodeEnrollmentToken(input: {
  enrollmentToken: string;
  name?: string;
  capabilities?: string[];
  maxAgents?: number;
  tags?: string[];
  version?: string;
  ip?: string | null;
}): Promise<{
  nodeId: string;
  nodeName: string;
  nodeToken: string;
  relayWorkspaceId: string;
  relaycastUrl: string;
}> {
  const token = input.enrollmentToken.trim();
  if (!token.startsWith(NODE_ENROLLMENT_TOKEN_PREFIX)) {
    throw new Error("Invalid enrollment token");
  }

  const tokenHash = hashToken(token);
  const now = new Date();
  const staleClaimCutoff = new Date(now.getTime() - CLAIM_STALE_MS);
  const claimNonce = crypto.randomUUID();
  const db = getDb();
  // Atomic conditional claim. The lookup is by tokenHash equality (the token is
  // high-entropy and only ever stored hashed, so the SQL equality is the secret
  // comparison — a redundant in-process compare added no timing protection). The
  // claim succeeds only if the token is unused, unexpired, and EITHER unclaimed
  // OR the prior claim has gone stale (the previous redeemer crashed before
  // minting/burning), which lets a bricked-mid-mint token be recovered.
  const [tokenRow] = await db
    .update(nodeEnrollmentTokens)
    .set({ claimNonce, claimedAt: now })
    .where(
      and(
        eq(nodeEnrollmentTokens.tokenHash, tokenHash),
        isNull(nodeEnrollmentTokens.usedAt),
        gt(nodeEnrollmentTokens.expiresAt, now),
        or(
          isNull(nodeEnrollmentTokens.claimNonce),
          lt(nodeEnrollmentTokens.claimedAt, staleClaimCutoff),
        ),
      ),
    )
    .returning();

  if (!tokenRow) {
    throw new Error("Invalid enrollment token");
  }

  const relayWorkspace = await getRelayWorkspace(tokenRow.relayWorkspaceId);
  let relayWorkspaceId = tokenRow.relayWorkspaceId;
  let apiKey = relayWorkspace?.relaycastApiKey?.trim() ?? "";
  if (!apiKey) {
    // The workspace's relaycast key was never minted (or is empty). Rather than
    // 500ing the enrollment, provision one on demand. resolveOrProvisionRelayWorkspace
    // is concurrency-safe (it re-checks the bound relay workspace before minting,
    // and a losing concurrent UPDATE of workspaces.relay_workspace_id is a lost
    // write, not corruption). The enrollment token row carries everything the
    // provisioner needs: createdBy is the minting user, workspaceId is the app
    // workspace UUID it was issued against.
    try {
      const provisioned = await resolveOrProvisionRelayWorkspace({
        userId: tokenRow.createdBy,
        appWorkspaceId: tokenRow.workspaceId,
      });
      relayWorkspaceId = provisioned.id;
      apiKey = provisioned.relaycastApiKey?.trim() ?? "";
    } catch (error) {
      console.error(
        "Node enrollment relaycast provisioning failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (!apiKey) {
    await db
      .update(nodeEnrollmentTokens)
      .set({ claimNonce: null, claimedAt: null })
      .where(and(eq(nodeEnrollmentTokens.id, tokenRow.id), eq(nodeEnrollmentTokens.claimNonce, claimNonce)));
    throw new Error(`Relaycast API key is not configured for workspace ${relayWorkspaceId}`);
  }

  const nodeName = input.name?.trim() || tokenRow.requestedName?.trim() || `node-${encodeBase58(8)}`;
  const capabilities = normalizeStringList(input.capabilities ?? tokenRow.capabilities);
  const tags = normalizeStringList(input.tags ?? tokenRow.tags);
  const maxAgents = normalizeMaxAgents(input.maxAgents ?? tokenRow.maxAgents);
  const relaycastUrl = trimTrailingSlash(resolveRelaycastUrl());
  let payload: { ok?: boolean; data?: { id?: string; name?: string; token?: string } } | null = null;
  let nodeToken: string | undefined;
  try {
    let result = await postRelaycastNode({
      relaycastUrl,
      apiKey,
      nodeName,
      capabilities,
      maxAgents,
      tags,
      version: input.version,
    });

    if (result.response.status === 401) {
      const provisioned = await resolveRelayWorkspaceAfterUnauthorized({
        userId: tokenRow.createdBy,
        appWorkspaceId: tokenRow.workspaceId,
        failedRelayWorkspaceId: relayWorkspaceId,
      });
      relayWorkspaceId = provisioned.id;
      apiKey = provisioned.relaycastApiKey?.trim() ?? "";
      if (!apiKey) {
        throw new Error(`Relaycast API key is not configured for workspace ${relayWorkspaceId}`);
      }
      result = await postRelaycastNode({
        relaycastUrl,
        apiKey,
        nodeName,
        capabilities,
        maxAgents,
        tags,
        version: input.version,
      });
    }

    const { response } = result;
    payload = result.payload;
    nodeToken = payload?.data?.token;
    if (!response.ok || !nodeToken) {
      throw new Error(`Relaycast node enrollment failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    await db
      .update(nodeEnrollmentTokens)
      .set({ claimNonce: null, claimedAt: null })
      .where(and(eq(nodeEnrollmentTokens.id, tokenRow.id), eq(nodeEnrollmentTokens.claimNonce, claimNonce)));
    throw error;
  }

  const [burned] = await db
    .update(nodeEnrollmentTokens)
    .set({ usedAt: new Date(), usedFromIp: input.ip ?? null, claimNonce: null, claimedAt: null })
    .where(and(eq(nodeEnrollmentTokens.id, tokenRow.id), eq(nodeEnrollmentTokens.claimNonce, claimNonce)))
    .returning({ id: nodeEnrollmentTokens.id });
  if (!burned) {
    throw new Error("Enrollment token claim was lost");
  }

  return {
    nodeId: payload?.data?.id ?? "",
    nodeName: payload?.data?.name ?? nodeName,
    nodeToken,
    relayWorkspaceId,
    relaycastUrl,
  };
}

export async function listFleetNodesForAppWorkspace(workspaceId: string): Promise<{
  relayWorkspaceId: string | null;
  nodes: FleetNode[];
}> {
  const [workspace] = await getDb()
    .select({ relayWorkspaceId: workspaces.relayWorkspaceId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const relayWorkspaceId = workspace?.relayWorkspaceId?.trim() || null;
  if (!relayWorkspaceId) {
    return { relayWorkspaceId: null, nodes: [] };
  }

  const relayWorkspace = await getRelayWorkspace(relayWorkspaceId);
  const apiKey = relayWorkspace?.relaycastApiKey.trim() ?? "";
  if (!apiKey) {
    return { relayWorkspaceId, nodes: [] };
  }

  const response = await fetch(`${trimTrailingSlash(resolveRelaycastUrl())}/v1/nodes`, {
    cache: "no-store",
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Relaycast node roster failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as { data?: FleetNode[] };
  return {
    relayWorkspaceId,
    nodes: Array.isArray(payload.data) ? payload.data : [],
  };
}
