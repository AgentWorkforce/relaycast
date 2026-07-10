import type { FilesystemEvent } from "@relayfile/sdk";

export interface WebSocketErrorShape {
  status: number;
  code: string;
  message: string;
}

export interface WebSocketHandlerContext {
  state: DurableObjectState;
  resolveWorkspaceId(
    request: Request,
    input?: { workspaceId?: string },
  ): Promise<string | null>;
  errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
  ): Response;
  getRecentEvents(limit: number): FilesystemEvent[];
}

export interface WebSocketEventMessage {
  type: string;
  path?: string;
  revision?: string;
  eventId?: string;
  contentHash?: string;
  provider?: string;
  correlationId?: string;
  timestamp: string;
}

export async function handleWebSocketUpgrade(
  ctx: WebSocketHandlerContext,
  request: Request,
  invalidInput: WebSocketErrorShape,
): Promise<Response> {
  const workspaceId = await ctx.resolveWorkspaceId(request, {
    workspaceId: extractWorkspaceIdFromRequest(request) ?? undefined,
  });
  if (!workspaceId) {
    return ctx.errorResponse(
      request,
      invalidInput.status,
      invalidInput.code,
      "missing workspaceId",
    );
  }

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  ctx.state.acceptWebSocket(server);

  const recentEvents = ctx.getRecentEvents(100);
  for (const event of recentEvents) {
    try {
      server.send(JSON.stringify(toWebSocketEventMessage(event)));
    } catch {
      break;
    }
  }

  return new Response(null, { status: 101, webSocket: client });
}

export async function webSocketMessage(
  _ctx: WebSocketHandlerContext,
  ws: WebSocket,
  message: string | ArrayBuffer,
): Promise<void> {
  if (typeof message !== "string") {
    return;
  }
  try {
    const parsed = JSON.parse(message) as { type?: string };
    if (parsed.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  } catch {
    // Ignore malformed frames from clients.
  }
}

export async function webSocketClose(
  _ctx: WebSocketHandlerContext,
  _ws: WebSocket,
): Promise<void> {
  // Hibernation removes sockets automatically.
}

export async function webSocketError(
  _ctx: WebSocketHandlerContext,
  _ws: WebSocket,
  _error: unknown,
): Promise<void> {
  // No-op.
}

export function broadcast(
  state: DurableObjectState,
  event: Pick<
    FilesystemEvent,
    | "type"
    | "path"
    | "revision"
    | "eventId"
    | "provider"
    | "correlationId"
    | "timestamp"
  > & { contentHash?: string },
): void {
  const payload = JSON.stringify(toWebSocketEventMessage(event));
  for (const socket of state.getWebSockets()) {
    try {
      socket.send(payload);
    } catch {
      // Socket may have closed between enumeration and send.
    }
  }
}

export function toWebSocketEventMessage(
  event: Pick<
    FilesystemEvent,
    | "type"
    | "path"
    | "revision"
    | "eventId"
    | "provider"
    | "correlationId"
    | "timestamp"
  > & { contentHash?: string },
): WebSocketEventMessage {
  return {
    type: event.type,
    path: event.path,
    revision: event.revision,
    eventId: event.eventId,
    contentHash: event.contentHash,
    provider: event.provider,
    correlationId: event.correlationId,
    timestamp: event.timestamp,
  };
}

function extractWorkspaceIdFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const routeWorkspaceId =
    segments[0] === "v1" && segments[1] === "workspaces" && segments[2]
      ? segments[2]
      : null;
  return (
    routeWorkspaceId ??
    request.headers.get("X-Workspace-Id")?.trim() ??
    url.searchParams.get("workspace_id")?.trim() ??
    null
  );
}
