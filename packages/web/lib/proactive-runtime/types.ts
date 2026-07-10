export type AgentInspectorSummary = {
  agentId: string;
  agentName: string;
  workspace: string;
  status: "online" | "offline";
  queueDepth: number;
  scheduleCount: number;
  watchCount: number;
  inboxCount: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  deployStartedAt: string | null;
  lastEvent: string | null;
  lastEventAt: string;
  lastError: string | null;
};

export type AgentActivityRecord = {
  id: string;
  kind:
    | "session.connected"
    | "session.disconnected"
    | "agent.registered"
    | "agent.unregistered"
    | "event.enqueued"
    | "event.acknowledged"
    | "event.retried"
    | "event.failed"
    | "log";
  occurredAt: string;
  eventId?: string;
  eventType?: string;
  level?: string;
  message?: string;
  attempt?: number;
  queueDepth?: number;
  detail?: Record<string, unknown>;
};

export type AgentInspectorDetail = AgentInspectorSummary & {
  schedules: Array<Record<string, unknown>>;
  watches: Array<Record<string, unknown>>;
  inbox: Array<Record<string, unknown>>;
  policy: {
    maxBacklog: number;
    handlerTimeoutMs: number;
  };
  recentEvents: AgentActivityRecord[];
};

export type WorkspaceMetricsSnapshot = {
  workspace: string;
  selectedAgentId?: string;
  totals: {
    eventsReceivedTotal: number;
    retriesTotal: number;
    dropsTotal: number;
    latencyP50Ms: number;
    latencyP95Ms?: number;
    latencyP99Ms?: number;
  };
  series: {
    eventsPerMinute: number[];
    eventsPerMinuteByType: Record<string, number[]>;
    retryRate: number[];
    dropRate: number[];
    latencyP50Ms: number[];
    latencyP95Ms: number[];
    latencyP99Ms: number[];
    costUsdPerMinute: number[];
    costUsdPerMinuteByEventType: Record<string, number[]>;
  };
  agents: Array<{
    agentId: string;
    summary: {
      eventsReceivedTotal: number;
      retriesTotal: number;
      dropsTotal: number;
      latencyP50Ms: number;
    };
    series: {
      eventsPerMinute: number[];
      retryRate: number[];
      dropRate: number[];
      latencyP50Ms: number[];
      latencyP95Ms: number[];
      latencyP99Ms: number[];
      costUsdPerMinute: number[];
    };
    byEventType: Array<{
      eventType: string;
      summary: {
        eventsReceivedTotal: number;
        retriesTotal: number;
        dropsTotal: number;
        latencyP50Ms: number;
      };
      costUsd: number;
    }>;
    costByEventType: Array<{
      eventType: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      sampleCount: number;
    }>;
  }>;
  costByEventType: Array<{
    eventType: string;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    sampleCount: number;
  }>;
};

export type DlqListItem = {
  eventId: string;
  path: string;
  revision: string;
  contentType: string;
  size: number;
  lastEditedAt: string;
};

export type LogFileRecord = {
  path: string;
  revision: string;
  contentType: string;
  size: number;
  lastEditedAt: string;
};
