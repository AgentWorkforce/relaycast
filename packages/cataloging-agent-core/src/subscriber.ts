import { DurableObject } from "cloudflare:workers";
import {
  RelayFileClient,
  RelayFileSync,
  type FilesystemEvent,
  type RelayFileSyncState,
} from "@relayfile/sdk";

import {
  getCatalogingAgentConfig,
  getInsight,
  resolveCatalogingToken,
  resolveRelayfileBaseUrl,
  type CatalogingWorkerEnv,
} from "./config.js";
import { writeConventionFragment } from "./conventions.js";
import type { CatalogingContext } from "./context.js";
import { writeInsight, type WriteInsightResult } from "./insight.js";

const CONFIG_KEY = "config";
const PENDING_KEY = "pending";
const RECONNECT_AT_KEY = "reconnectAt";
const LAST_SOCKET_ACTIVITY_KEY = "lastSocketActivityAt";
const CONNECTED_SINCE_KEY = "connectedSince";
const EVENTS_RECEIVED_COUNT_KEY = "eventsReceivedCount";
const LAST_EVENT_AT_KEY = "lastEventAt";
const SYNC_STATE_KEY = "syncState";
const SOCKET_TAG = "cataloging-relayfile-sync";
const RECONNECT_CHECK_MS = 60_000;
const SOCKET_STALE_MS = 5 * 60_000;

interface StoredSubscriptionConfig {
  workspaceId: string;
  domain: string;
  relayfileUrl: string;
  updatedAt: string;
}

type PendingInsightMap = Record<string, number>;

export class CatalogingSubscriber extends DurableObject {
  readonly #state: DurableObjectState;
  readonly #env: CatalogingWorkerEnv;
  readonly #ready: Promise<void>;
  #config: StoredSubscriptionConfig | null = null;
  #sync: RelayFileSync | null = null;
  /**
   * Tracks whether the convention fragment has been emitted during this
   * cold-start. Persisting across DO hibernation isn't necessary: the
   * RelayFile-side hash compare keeps repeated emits idempotent on the
   * wire. This flag is purely a no-op short-circuit when the same DO
   * instance handles many events in a row.
   */
  #conventionsEmitted = false;

  constructor(state: DurableObjectState, env: CatalogingWorkerEnv) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    this.#installWebSocketAutoResponse();
    this.#ready = state.blockConcurrencyWhile(async () => {
      this.#config = (await state.storage.get<StoredSubscriptionConfig>(CONFIG_KEY)) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.#ready;
    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/subscribe") {
        const config = await this.#storeConfigFromRequest(request);
        await this.#ensureSubscription();
        return jsonResponse({ status: "ok", config, sockets: this.#socketCount() });
      }

      if (request.method === "POST" && url.pathname.startsWith("/run/")) {
        await this.#storeConfigFromRequest(request, { allowExisting: true });
        const insightId = decodeURIComponent(url.pathname.slice("/run/".length));
        const insight = getInsight(getCatalogingAgentConfig(), insightId);
        if (!insight) {
          return jsonResponse({ error: "unknown insight", insightId }, { status: 404 });
        }
        const result = await this.#runInsight(insightId, "manual");
        return jsonResponse({ status: "ok", result });
      }

      if (request.method === "POST" && url.pathname === "/run-overdue") {
        await this.#storeConfigFromRequest(request, { allowExisting: true });
        const results = await this.#runOverdue();
        await this.#ensureSubscription();
        return jsonResponse({ status: "ok", results });
      }

      if (request.method === "GET" && url.pathname === "/status") {
        return jsonResponse(await this.#status());
      }

      return jsonResponse({ error: "not found" }, { status: 404 });
    } catch (error) {
      console.error(
        `[cataloging] ${JSON.stringify({
          event: "subscriber_request_error",
          path: url.pathname,
          workspaceId: this.#config?.workspaceId ?? null,
          domain: this.#config?.domain ?? null,
          error: error instanceof Error ? error.message : "internal error",
          at: new Date().toISOString(),
        })}`,
      );
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "internal error",
        },
        { status: 500 },
      );
    }
  }

  async alarm(): Promise<void> {
    await this.#ready;
    const now = Date.now();
    const reconnectAt = await this.#state.storage.get<number>(RECONNECT_AT_KEY);

    if (this.#config && (!reconnectAt || reconnectAt <= now)) {
      await this.#ensureSubscription();
    }

    const pending = await this.#getPending();
    const dueInsightIds = Object.entries(pending)
      .filter(([, dueAt]) => dueAt <= now)
      .map(([insightId]) => insightId);

    if (dueInsightIds.length > 0) {
      const remaining = Object.fromEntries(
        Object.entries(pending).filter(([, dueAt]) => dueAt > now),
      );
      await this.#putPending(remaining);
      // Mirror #runOverdue: wrap each insight so one failure doesn't
      // skip siblings OR prevent the next alarm from being scheduled.
      // #runInsight records its own errors before rethrowing, so
      // swallowing here is safe.
      for (const insightId of dueInsightIds) {
        try {
          await this.#runInsight(insightId, "event");
        } catch (error) {
          console.error(
            `[cataloging] ${JSON.stringify({
              event: "event_insight_failed",
              insightId,
              workspaceId: this.#config?.workspaceId ?? null,
              domain: this.#config?.domain ?? null,
              error: error instanceof Error ? error.message : "unknown error",
              at: new Date().toISOString(),
            })}`,
          );
          // Already recorded by #runInsight; continue to the next.
        }
      }
    }

    await this.#scheduleNextAlarm();
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#ready;
    await this.#recordSocketActivity();
    if (typeof message !== "string") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (isFilesystemEvent(parsed)) {
      await this.#handleEvent(parsed);
    }
  }

  async webSocketClose(): Promise<void> {
    await this.#ready;
    this.#sync = null;
    await this.#scheduleReconnectCheck(1_000);
  }

  async webSocketError(): Promise<void> {
    await this.#ready;
    this.#sync = null;
    await this.#scheduleReconnectCheck(1_000);
  }

  async #ensureSubscription(): Promise<void> {
    const config = await this.#requireConfig();

    // Emit the convention fragment alongside subscription bring-up. The
    // write itself is idempotent (RelayFile-side hash compare), and the
    // in-memory #conventionsEmitted flag avoids redundant reads when the
    // same DO handles many events in a row. Scheduled before the
    // early-return branches below so DO instances that wake with an
    // existing hibernated socket (or already-open sync state) still
    // publish /_conventions/<provider>.json on first subscribe/alarm.
    this.#state.waitUntil(this.#emitConventionsIfConfigured());

    let state = this.#sync?.getState();
    const socketCount = this.#socketCount();

    if (socketCount > 0 && (await this.#hibernatedSocketIsStale())) {
      this.#closeHibernatedSockets();
      this.#sync = null;
      // #sync has been cleared — previously-captured state is now stale,
      // don't let it block immediate reconnection below.
      state = undefined;
    }

    if (this.#socketCount() > 0 && (!state || state === "closed")) {
      await this.#scheduleReconnectCheck();
      return;
    }

    if (state && state !== "closed") {
      await this.#scheduleReconnectCheck();
      return;
    }

    const appConfig = getCatalogingAgentConfig();
    const token = await resolveCatalogingToken(appConfig, this.#env, config.workspaceId);
    const relayfile = new RelayFileClient({
      baseUrl: config.relayfileUrl,
      token,
      userAgent: `cataloging-agent-core/${config.domain}`,
      readCache: {},
    });

    this.#sync = RelayFileSync.connect({
      client: relayfile,
      workspaceId: config.workspaceId,
      baseUrl: config.relayfileUrl,
      token,
      reconnect: {
        enabled: true,
        minDelayMs: 250,
        maxDelayMs: 5_000,
      },
      onEvent: (event) => {
        this.#state.waitUntil(this.#handleEvent(event));
      },
      webSocketFactory: (url) => this.#openHibernatingWebSocket(url, config),
    });

    await this.#markConnectedSince();

    this.#sync.on("state", (syncState) => {
      this.#state.waitUntil(this.#state.storage.put(SYNC_STATE_KEY, syncState));
    });
    this.#sync.on("open", () => {
      this.#state.waitUntil(
        Promise.all([this.#markConnectedSince(), this.#recordSocketActivity()]).then(() => undefined),
      );
    });
    this.#sync.on("pong", () => {
      this.#state.waitUntil(this.#recordSocketActivity());
    });
    this.#sync.on("close", () => {
      this.#state.waitUntil(this.#scheduleReconnectCheck(1_000));
    });
    this.#sync.on("error", (error) => {
      this.#state.waitUntil(
        this.#state.storage.put("lastSyncError", {
          message: error instanceof Error ? error.message : "websocket error",
          at: new Date().toISOString(),
        }),
      );
    });

    await this.#scheduleReconnectCheck();
  }

  async #emitConventionsIfConfigured(): Promise<void> {
    if (this.#conventionsEmitted) {
      return;
    }
    const appConfig = getCatalogingAgentConfig();
    if (!appConfig.conventions) {
      this.#conventionsEmitted = true;
      return;
    }

    const config = await this.#requireConfig();
    const token = await resolveCatalogingToken(appConfig, this.#env, config.workspaceId);
    const client = new RelayFileClient({
      baseUrl: config.relayfileUrl,
      token,
      userAgent: `cataloging-agent-core/${config.domain}`,
      readCache: {},
    });

    try {
      const fragment = appConfig.conventions();
      await writeConventionFragment({
        client,
        workspaceId: config.workspaceId,
        fragment,
      });
      this.#conventionsEmitted = true;
    } catch (error) {
      await this.#state.storage.put("lastConventionError", {
        message: error instanceof Error ? error.message : "convention emit failed",
        at: new Date().toISOString(),
      });
      // Leave #conventionsEmitted false so the next subscribe/reconnect retries.
    }
  }

  async #handleEvent(event: FilesystemEvent): Promise<void> {
    if (!event.path) {
      return;
    }

    await this.#recordEventReceived();

    const appConfig = getCatalogingAgentConfig();
    for (const insight of appConfig.insights) {
      if (insight.triggerPaths.some((prefix) => pathMatchesPrefix(event.path, prefix))) {
        await this.#enqueueRegenerate(insight.id);
      }
    }
  }

  async #enqueueRegenerate(insightId: string): Promise<void> {
    const appConfig = getCatalogingAgentConfig();
    const insight = getInsight(appConfig, insightId);
    if (!insight) {
      return;
    }

    const pending = await this.#getPending();
    pending[insightId] = Date.now() + Math.max(0, Math.floor(insight.debounceMs));
    await this.#putPending(pending);
    await this.#scheduleNextAlarm();
  }

  async #runOverdue(): Promise<Array<{ insightId: string; due: boolean; result?: WriteInsightResult; error?: string }>> {
    const appConfig = getCatalogingAgentConfig();
    const now = Date.now();
    const results: Array<{ insightId: string; due: boolean; result?: WriteInsightResult; error?: string }> = [];

    for (const insight of appConfig.insights) {
      const lastRun = await this.#state.storage.get<number>(lastRunKey(insight.id));
      const due =
        lastRun === undefined ||
        insight.intervalSeconds <= 0 ||
        now - lastRun >= Math.floor(insight.intervalSeconds * 1000);
      if (!due) {
        results.push({ insightId: insight.id, due: false });
        continue;
      }

      try {
        results.push({
          insightId: insight.id,
          due: true,
          result: await this.#runInsight(insight.id, "overdue"),
        });
      } catch (error) {
        results.push({
          insightId: insight.id,
          due: true,
          error: error instanceof Error ? error.message : "unknown error",
        });
        console.error(
          `[cataloging] ${JSON.stringify({
            event: "overdue_insight_failed",
            insightId: insight.id,
            workspaceId: this.#config?.workspaceId ?? null,
            domain: this.#config?.domain ?? null,
            error: error instanceof Error ? error.message : "unknown error",
            at: new Date().toISOString(),
          })}`,
        );
      }
    }

    return results;
  }

  async #runInsight(insightId: string, reason: string): Promise<WriteInsightResult> {
    const appConfig = getCatalogingAgentConfig();
    const insight = getInsight(appConfig, insightId);
    if (!insight) {
      throw new Error(`unknown insight: ${insightId}`);
    }

    const context = await this.#createContext();
    try {
      const generated = await insight.generate(context);
      const result = await writeInsight(context, insight, generated);
      await this.#state.storage.put(lastRunKey(insightId), Date.now());
      await this.#state.storage.delete(lastErrorKey(insightId));
      await this.#state.storage.put(`lastReason:${insightId}`, reason);
      await this.#state.storage.put(`lastResult:${insightId}`, {
        status: result.status,
        path: result.path,
        contentIdentity: result.contentIdentity,
        reason,
        at: new Date().toISOString(),
      });
      console.log(
        `[cataloging] ${JSON.stringify({
          event: "insight_completed",
          insightId,
          workspaceId: context.workspaceId,
          domain: context.domain,
          reason,
          result: {
            status: result.status,
            path: result.path,
            contentIdentity: result.contentIdentity,
          },
          at: new Date().toISOString(),
        })}`,
      );
      return result;
    } catch (error) {
      await this.#state.storage.put(lastErrorKey(insightId), {
        message: error instanceof Error ? error.message : "unknown error",
        at: new Date().toISOString(),
        reason,
      });
      console.error(
        `[cataloging] ${JSON.stringify({
          event: "insight_failed",
          insightId,
          workspaceId: context.workspaceId,
          domain: context.domain,
          reason,
          error: error instanceof Error ? error.message : "unknown error",
          at: new Date().toISOString(),
        })}`,
      );
      throw error;
    }
  }

  async #createContext(): Promise<CatalogingContext<CatalogingWorkerEnv>> {
    const config = await this.#requireConfig();
    const appConfig = getCatalogingAgentConfig();
    const token = await resolveCatalogingToken(appConfig, this.#env, config.workspaceId);
    return {
      workspaceId: config.workspaceId,
      domain: config.domain,
      relayfileUrl: config.relayfileUrl,
      relayfileToken: token,
      relayfile: new RelayFileClient({
        baseUrl: config.relayfileUrl,
        token,
        userAgent: `cataloging-agent-core/${config.domain}`,
        readCache: {},
      }),
      env: this.#env,
      now: new Date(),
    };
  }

  async #storeConfigFromRequest(
    request: Request,
    options: { allowExisting?: boolean } = {},
  ): Promise<StoredSubscriptionConfig> {
    const input = await readJsonObject(request);
    const appConfig = getCatalogingAgentConfig();
    const workspaceId =
      readString(input.workspaceId) ??
      readString(input.workspace_id) ??
      request.headers.get("x-workspace-id")?.trim() ??
      new URL(request.url).searchParams.get("workspaceId")?.trim() ??
      this.#config?.workspaceId;

    if (!workspaceId) {
      if (options.allowExisting && this.#config) {
        return this.#config;
      }
      throw new Error("missing workspaceId");
    }

    const relayfileUrl =
      readString(input.relayfileUrl) ??
      readString(input.relayfile_url) ??
      this.#config?.relayfileUrl ??
      (await resolveRelayfileBaseUrl(appConfig, this.#env));

    const config: StoredSubscriptionConfig = {
      workspaceId,
      domain: readString(input.domain) ?? this.#config?.domain ?? appConfig.domain,
      relayfileUrl,
      updatedAt: new Date().toISOString(),
    };

    this.#config = config;
    await this.#state.storage.put(CONFIG_KEY, config);
    return config;
  }

  async #status(): Promise<Record<string, unknown>> {
    const appConfig = getCatalogingAgentConfig();
    const pending = await this.#getPending();
    const lastRuns: Record<string, number | null> = {};
    const lastErrors: Record<string, unknown> = {};
    const lastResults: Record<string, unknown> = {};
    for (const insight of appConfig.insights) {
      lastRuns[insight.id] = (await this.#state.storage.get<number>(lastRunKey(insight.id))) ?? null;
      const lastError = await this.#state.storage.get(lastErrorKey(insight.id));
      if (lastError !== undefined) {
        lastErrors[insight.id] = lastError;
      }
      const lastResult = await this.#state.storage.get(`lastResult:${insight.id}`);
      if (lastResult !== undefined) {
        lastResults[insight.id] = lastResult;
      }
    }

    return {
      status: "ok",
      config: this.#config,
      syncState: this.#sync?.getState() ?? ((await this.#state.storage.get<RelayFileSyncState>(SYNC_STATE_KEY)) ?? "idle"),
      sockets: this.#socketCount(),
      pending,
      lastRuns,
      lastErrors,
      lastResults,
      connectedSince: (await this.#state.storage.get<string>(CONNECTED_SINCE_KEY)) ?? null,
      eventsReceivedCount: (await this.#state.storage.get<number>(EVENTS_RECEIVED_COUNT_KEY)) ?? 0,
      lastEventAt: (await this.#state.storage.get<string>(LAST_EVENT_AT_KEY)) ?? null,
      nextAlarmAt: await this.#nextAlarmAt(),
      lastSocketActivityAt: (await this.#state.storage.get<number>(LAST_SOCKET_ACTIVITY_KEY)) ?? null,
    };
  }

  async #requireConfig(): Promise<StoredSubscriptionConfig> {
    if (this.#config) {
      return this.#config;
    }
    const stored = await this.#state.storage.get<StoredSubscriptionConfig>(CONFIG_KEY);
    if (!stored) {
      throw new Error("cataloging subscription has not been configured");
    }
    this.#config = stored;
    return stored;
  }

  async #getPending(): Promise<PendingInsightMap> {
    return (await this.#state.storage.get<PendingInsightMap>(PENDING_KEY)) ?? {};
  }

  async #putPending(pending: PendingInsightMap): Promise<void> {
    const entries = Object.entries(pending);
    if (entries.length === 0) {
      await this.#state.storage.delete(PENDING_KEY);
      return;
    }
    await this.#state.storage.put(PENDING_KEY, Object.fromEntries(entries));
  }

  async #scheduleNextAlarm(): Promise<void> {
    const pending = await this.#getPending();
    const reconnectAt = await this.#state.storage.get<number>(RECONNECT_AT_KEY);
    const times = [...Object.values(pending), reconnectAt].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );

    if (times.length === 0) {
      await this.#state.storage.deleteAlarm();
      return;
    }

    await this.#state.storage.setAlarm(Math.max(Date.now(), Math.min(...times)));
  }

  async #scheduleReconnectCheck(delayMs = RECONNECT_CHECK_MS): Promise<void> {
    await this.#state.storage.put(RECONNECT_AT_KEY, Date.now() + Math.max(1_000, delayMs));
    await this.#scheduleNextAlarm();
  }

  #openHibernatingWebSocket(url: string, config: StoredSubscriptionConfig): WebSocket {
    const socket = new WebSocket(url);
    try {
      this.#state.acceptWebSocket(socket, [SOCKET_TAG, `workspace:${config.workspaceId}`, `domain:${config.domain}`]);
      socket.serializeAttachment?.({
        workspaceId: config.workspaceId,
        domain: config.domain,
        relayfileUrl: config.relayfileUrl,
      });
    } catch {
      socket.accept?.();
    }
    return socket;
  }

  #installWebSocketAutoResponse(): void {
    try {
      this.#state.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(JSON.stringify({ type: "ping" }), JSON.stringify({ type: "pong" })),
      );
      this.#state.setHibernatableWebSocketEventTimeout(30_000);
    } catch {
      // Non-Cloudflare test environments do not expose the hibernation API.
    }
  }

  #socketCount(): number {
    try {
      return this.#state.getWebSockets(SOCKET_TAG).length;
    } catch {
      return 0;
    }
  }

  async #hibernatedSocketIsStale(): Promise<boolean> {
    const lastActivity = await this.#state.storage.get<number>(LAST_SOCKET_ACTIVITY_KEY);
    return typeof lastActivity === "number" && Date.now() - lastActivity > SOCKET_STALE_MS;
  }

  #closeHibernatedSockets(): void {
    for (const socket of this.#state.getWebSockets(SOCKET_TAG)) {
      try {
        socket.close(1012, "cataloging subscriber reconnecting stale relayfile sync socket");
      } catch {
        // Socket may already be closing.
      }
    }
  }

  async #recordSocketActivity(): Promise<void> {
    await this.#state.storage.put(LAST_SOCKET_ACTIVITY_KEY, Date.now());
  }

  async #markConnectedSince(): Promise<void> {
    const existing = await this.#state.storage.get<string>(CONNECTED_SINCE_KEY);
    if (!existing) {
      await this.#state.storage.put(CONNECTED_SINCE_KEY, new Date().toISOString());
    }
  }

  async #recordEventReceived(): Promise<void> {
    const count = (await this.#state.storage.get<number>(EVENTS_RECEIVED_COUNT_KEY)) ?? 0;
    await this.#state.storage.put(EVENTS_RECEIVED_COUNT_KEY, count + 1);
    await this.#state.storage.put(LAST_EVENT_AT_KEY, new Date().toISOString());
  }

  async #nextAlarmAt(): Promise<number | null> {
    try {
      return await this.#state.storage.getAlarm();
    } catch {
      return null;
    }
  }
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPrefix = normalizePath(prefix);
  if (normalizedPrefix === "/" || normalizedPrefix === "*") {
    return true;
  }
  if (normalizedPrefix.endsWith("*")) {
    return normalizedPath.startsWith(normalizedPrefix.slice(0, -1));
  }
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix.replace(/\/$/, "")}/`);
}

function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/{2,}/g, "/");
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }
  try {
    const parsed = (await request.json()) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isFilesystemEvent(value: unknown): value is FilesystemEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lastRunKey(insightId: string): string {
  return `lastRun:${insightId}`;
}

function lastErrorKey(insightId: string): string {
  return `lastError:${insightId}`;
}
