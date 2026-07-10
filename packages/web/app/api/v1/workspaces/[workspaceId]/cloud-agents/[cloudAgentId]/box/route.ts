import { NextRequest, NextResponse } from "next/server";
import {
  CloudAgentBoxError,
  defaultCloudAgentBoxDeps,
  readCloudAgentBox,
  startCloudAgentBoxWarm,
  stopCloudAgentBox,
  updateCloudAgentBoxMountPaths,
  warmCloudAgentBox,
  type CloudAgentBoxDeps,
  type CloudAgentWorkspaceSource,
} from "./box-manager";
import {
  isCloudAgentWarmViaQueueEnabled,
  readCloudAgentBoxViaQueue,
  startCloudAgentBoxWarmViaQueue,
} from "./warm-route";
import {
  isRecord,
  jsonError,
  readJsonBody,
  requireWorkspaceSandboxAuth,
} from "../../../sandboxes/sandbox-utils";

type RouteContext = {
  params: Promise<{ workspaceId: string; cloudAgentId: string }>;
};

function parseMountPathsBody(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.relayfileMountPaths)) {
    return null;
  }
  if (!value.relayfileMountPaths.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value.relayfileMountPaths;
}

function parseOptionalMountPathsBody(value: unknown): string[] | undefined | null {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (!("relayfileMountPaths" in value)) {
    return undefined;
  }
  return parseMountPathsBody(value);
}

type BrokerIdentityBody = { workspaceKey?: string; brokerName?: string };

/**
 * #125 broker identity (POST only — provision-time, immutable for the sandbox
 * lifetime; PATCH intentionally does not parse these). Values are passed
 * through verbatim: pear is the naming authority. A present-but-not-a-string
 * or blank value is a 400, not silently ignored — a caller that tried to pin
 * a workspace must not end up with an isolated broker.
 */
function parseOptionalBrokerIdentityBody(value: unknown): BrokerIdentityBody | null {
  if (!isRecord(value)) {
    return {};
  }
  const identity: BrokerIdentityBody = {};
  for (const key of ["workspaceKey", "brokerName"] as const) {
    const raw = value[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    if (typeof raw !== "string" || !raw.trim()) {
      return null;
    }
    identity[key] = raw;
  }
  return identity;
}

function normalizeHttpsGitRemote(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseOptionalWorkspaceSourceBody(
  value: unknown,
): CloudAgentWorkspaceSource | undefined | null {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !("workspaceSource" in value)) {
    return undefined;
  }
  const source = value.workspaceSource;
  if (!isRecord(source)) {
    return null;
  }
  if (source.kind === "relayfile") {
    return { kind: "relayfile" };
  }
  if (
    (source.kind !== "git" && source.kind !== "git-overlay") ||
    typeof source.remoteUrl !== "string"
  ) {
    return null;
  }
  const remoteUrl = normalizeHttpsGitRemote(source.remoteUrl);
  if (!remoteUrl) {
    return null;
  }
  const targetDir = typeof source.targetDir === "string" && source.targetDir.trim()
    ? source.targetDir.trim()
    : undefined;
  if (targetDir && targetDir !== "/workspace" && !targetDir.startsWith("/workspace/")) {
    return null;
  }
  return {
    kind: source.kind,
    remoteUrl,
    ...(typeof source.ref === "string" && source.ref.trim() ? { ref: source.ref.trim() } : {}),
    ...(typeof source.commit === "string" && source.commit.trim() ? { commit: source.commit.trim() } : {}),
    ...(typeof source.shallow === "boolean" ? { shallow: source.shallow } : {}),
    ...(targetDir ? { targetDir } : {}),
    ...(typeof source.largeReason === "string" && source.largeReason.trim()
      ? { largeReason: source.largeReason.trim() }
      : {}),
  };
}

function wantsAsyncWarm(request: NextRequest): boolean {
  const value = request.nextUrl.searchParams.get("async")?.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  const header = request.headers.get("x-async-warm")?.trim().toLowerCase();
  return header === "true" || header === "1" || header === "yes";
}

function isDaytonaUpstreamTimeoutMessage(message: string): boolean {
  if (!message) return false;
  return (
    message.includes("524: A timeout occurred") ||
    message.includes("proxy.app.daytona.io") ||
    /\b52[02-4]\b.*timeout/i.test(message)
  );
}

function routeError(error: unknown): NextResponse {
  if (error instanceof CloudAgentBoxError) {
    return jsonError(error.message, error.code, error.status);
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  // Defence in depth: `box-manager.ts:retryOnDaytonaUpstreamTimeout` already
  // wraps the known-slow Daytona calls and rethrows as CloudAgentBoxError
  // when retries are exhausted, so this branch should normally not fire.
  // If a 524 slips through from a call we haven't wrapped, surface a
  // clean error to the caller instead of the doubled-up HTML-in-JSON
  // gibberish ("Failed to warm cloud agent box: <!DOCTYPE html>...").
  if (isDaytonaUpstreamTimeoutMessage(rawMessage)) {
    console.error(
      "[cloud-agent-box] unwrapped daytona upstream timeout reached routeError",
      { messagePreview: rawMessage.slice(0, 200) },
    );
    return jsonError(
      "Daytona is currently unresponsive — please retry in a moment",
      "daytona_upstream_timeout",
      504,
    );
  }
  console.error(
    "[cloud-agent-box] request failed:",
    rawMessage,
  );
  return jsonError("Failed to warm cloud agent box", "box_request_failed", 503);
}

export function createCloudAgentBoxRouteHandlers(
  deps: CloudAgentBoxDeps = defaultCloudAgentBoxDeps(),
) {
  async function readInput(request: NextRequest, context: RouteContext) {
    const authResult = await requireWorkspaceSandboxAuth(request, context);
    if (!authResult.ok) {
      return authResult.response;
    }
    const { cloudAgentId } = await context.params;
    if (!cloudAgentId) {
      return jsonError("Cloud agent not found", "cloud_agent_not_found", 404);
    }
    return {
      auth: authResult.auth,
      urlWorkspaceId: authResult.workspaceId,
      cloudAgentId,
      workspaceToken: null,
    };
  }

  async function POST(request: NextRequest, context: RouteContext) {
    const input = await readInput(request, context);
    if (input instanceof NextResponse) {
      return input;
    }
    const body = await readJsonBody(request);
    const mountPaths = parseOptionalMountPathsBody(body);
    const workspaceSource = parseOptionalWorkspaceSourceBody(body);
    const brokerIdentity = parseOptionalBrokerIdentityBody(body);
    if (mountPaths === null || workspaceSource === null || brokerIdentity === null) {
      return jsonError("Invalid request body", "invalid_request", 400);
    }
    const warmInput = { ...input, mountPaths, workspaceSource, ...brokerIdentity };
    try {
      if (isCloudAgentWarmViaQueueEnabled()) {
        const result = await startCloudAgentBoxWarmViaQueue(deps, warmInput);
        return NextResponse.json(result.response, { status: result.status });
      }
      if (wantsAsyncWarm(request)) {
        const result = await startCloudAgentBoxWarm(deps, warmInput);
        return NextResponse.json(result.response, { status: result.status });
      }
      return NextResponse.json(
        await warmCloudAgentBox(deps, warmInput),
        { status: 201 },
      );
    } catch (error) {
      return routeError(error);
    }
  }

  async function GET(request: NextRequest, context: RouteContext) {
    const input = await readInput(request, context);
    if (input instanceof NextResponse) {
      return input;
    }
    try {
      const response = isCloudAgentWarmViaQueueEnabled()
        ? await readCloudAgentBoxViaQueue(deps, input)
        : await readCloudAgentBox(deps, input);
      return NextResponse.json(response);
    } catch (error) {
      return routeError(error);
    }
  }

  async function PATCH(request: NextRequest, context: RouteContext) {
    const input = await readInput(request, context);
    if (input instanceof NextResponse) {
      return input;
    }
    const body = await readJsonBody(request);
    const mountPaths = parseMountPathsBody(body);
    const workspaceSource = parseOptionalWorkspaceSourceBody(body);
    if (!mountPaths || workspaceSource === null) {
      return jsonError("Invalid request body", "invalid_request", 400);
    }
    try {
      return NextResponse.json(
        await updateCloudAgentBoxMountPaths(deps, { ...input, mountPaths, workspaceSource }),
      );
    } catch (error) {
      return routeError(error);
    }
  }

  async function DELETE(request: NextRequest, context: RouteContext) {
    const input = await readInput(request, context);
    if (input instanceof NextResponse) {
      return input;
    }
    try {
      return NextResponse.json(await stopCloudAgentBox(deps, input));
    } catch (error) {
      return routeError(error);
    }
  }

  return { POST, GET, PATCH, DELETE };
}

export const { POST, GET, PATCH, DELETE } = createCloudAgentBoxRouteHandlers();
