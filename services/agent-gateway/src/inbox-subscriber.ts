import {
  AgentClient,
  HttpClient,
  type DeliveryAcceptedEvent,
  type RelaycastMessageEvent,
} from "@relaycast/sdk";

export type RelaycastInboxRegistration = {
  agentId: string;
  accessToken: string;
  selectors: string[];
};

export type RelaycastInboxDeliveryAccepted = {
  deliveryId: string;
  messageId: string;
};

export type RelaycastInboxMessageEvent = {
  id: string;
  channel: string;
  messageId: string;
  threadId?: string;
  text: string;
  occurredAt: string;
  from: {
    id: string;
    displayName?: string;
  };
};

export type RelaycastInboxSubscription = {
  unsubscribe(): void;
};

export type RelaycastInboxClient = {
  subscribe(
    channels: string[],
    onMessage: (event: RelaycastMessageEvent) => void | Promise<void>,
  ): RelaycastInboxSubscription;
  /**
   * Listen for `delivery.accepted` lifecycle events on this connection. The
   * engine scopes these to the authenticated agent, so the recipient is the
   * agent the connection was created for. Returns a stop function.
   */
  onDeliveryAccepted?(
    handler: (event: RelaycastInboxDeliveryAccepted) => void,
  ): () => void;
  disconnect(): Promise<void> | void;
};

export type RelaycastInboxClientFactory = (input: {
  agentId: string;
  accessToken: string;
  baseUrl?: string;
}) => RelaycastInboxClient;

type ResolvedRegistration = {
  agentId: string;
  accessToken: string;
  channelSelectors: string[];
  hasSelf: boolean;
};

type ChannelConnection = {
  agentId: string;
  accessToken: string;
  selectors: Set<string>;
  client: RelaycastInboxClient;
  subscription: RelaycastInboxSubscription;
  stopDeliveryListener?: () => void;
};

type SelfConnection = {
  accessToken: string;
  client: RelaycastInboxClient;
  subscription: RelaycastInboxSubscription;
  stopDeliveryListener?: () => void;
};

export class WorkspaceInboxSubscriber {
  private channelConnection: ChannelConnection | null = null;
  private readonly selfConnections = new Map<string, SelfConnection>();

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly createClient: RelaycastInboxClientFactory,
    private readonly onChannelEvent:
      (selector: string, event: RelaycastInboxMessageEvent) => Promise<void> | void,
    private readonly onSelfEvent:
      (agentId: string, event: RelaycastInboxMessageEvent) => Promise<void> | void,
    private readonly onError: (error: unknown) => Promise<void> | void,
    private readonly onDeliveryAccepted?:
      (agentId: string, event: RelaycastInboxDeliveryAccepted) => void,
  ) {}

  async update(registrations: readonly RelaycastInboxRegistration[]): Promise<void> {
    const resolved = registrations
      .map((registration) => resolveRegistration(registration))
      .filter((registration): registration is ResolvedRegistration =>
        Boolean(registration && registration.accessToken.trim().length > 0),
      );

    await this.updateSharedChannels(resolved);
    await this.updateSelfSubscriptions(resolved);
  }

  async close(): Promise<void> {
    await this.tearDownChannelConnection();
    await Promise.all(
      [...this.selfConnections.values()].map((connection) =>
        this.tearDownConnection(connection),
      ),
    );
    this.selfConnections.clear();
  }

  private async updateSharedChannels(
    registrations: readonly ResolvedRegistration[],
  ): Promise<void> {
    const selectors = [...new Set(
      registrations.flatMap((registration) => registration.channelSelectors),
    )];
    if (selectors.length === 0) {
      await this.tearDownChannelConnection();
      return;
    }

    const owner = registrations.find((registration) => registration.channelSelectors.length > 0);
    if (!owner) {
      return;
    }

    const ownerChanged =
      !this.channelConnection
      || this.channelConnection.agentId !== owner.agentId
      || this.channelConnection.accessToken !== owner.accessToken;
    const selectorsChanged =
      !this.channelConnection
      || !sameSet(this.channelConnection.selectors, new Set(selectors));

    if (!ownerChanged && !selectorsChanged) {
      return;
    }

    await this.tearDownChannelConnection();
    const client = this.createClient({
      agentId: owner.agentId,
      accessToken: owner.accessToken,
      baseUrl: this.baseUrl,
    });
    const selectorSet = new Set(selectors);
    const subscription = client.subscribe(selectors, (event) => {
      void this.handleSharedChannelEvent(event, selectorSet);
    });
    this.channelConnection = {
      agentId: owner.agentId,
      accessToken: owner.accessToken,
      selectors: selectorSet,
      client,
      subscription,
      // delivery.accepted events on this connection are scoped to the owner
      // agent's own deliveries; other channel recipients are resolved at
      // settle time from the durable deliveries feed.
      stopDeliveryListener: this.attachDeliveryListener(client, owner.agentId),
    };
  }

  private async updateSelfSubscriptions(
    registrations: readonly ResolvedRegistration[],
  ): Promise<void> {
    const nextSelfRegistrations = new Map(
      registrations
        .filter((registration) => registration.hasSelf)
        .map((registration) => [registration.agentId, registration] as const),
    );

    for (const [agentId, connection] of this.selfConnections.entries()) {
      if (!nextSelfRegistrations.has(agentId)) {
        await this.tearDownConnection(connection);
        this.selfConnections.delete(agentId);
      }
    }

    for (const [agentId, registration] of nextSelfRegistrations.entries()) {
      const existing = this.selfConnections.get(agentId);
      if (existing && existing.accessToken === registration.accessToken) {
        continue;
      }
      if (existing) {
        await this.tearDownConnection(existing);
        this.selfConnections.delete(agentId);
      }
      const client = this.createClient({
        agentId,
        accessToken: registration.accessToken,
        baseUrl: this.baseUrl,
      });
      const subscription = client.subscribe(["@self"], (event) => {
        void this.handleSelfEvent(agentId, event);
      });
      this.selfConnections.set(agentId, {
        accessToken: registration.accessToken,
        client,
        subscription,
        stopDeliveryListener: this.attachDeliveryListener(client, agentId),
      });
    }
  }

  private async handleSharedChannelEvent(
    event: RelaycastMessageEvent,
    activeSelectors: Set<string>,
  ): Promise<void> {
    if (event.type !== "message.created" && event.type !== "thread.reply") {
      return;
    }
    const selector = normalizeRelaycastChannel(event.channel);
    if (!activeSelectors.has(selector)) {
      return;
    }
    try {
      await this.onChannelEvent(selector, toInboxEvent(event));
    } catch (error) {
      void this.onError(error);
    }
  }

  private async handleSelfEvent(
    agentId: string,
    event: RelaycastMessageEvent,
  ): Promise<void> {
    if (event.type !== "dm.received" && event.type !== "group_dm.received") {
      return;
    }
    try {
      await this.onSelfEvent(agentId, toInboxEvent(event));
    } catch (error) {
      void this.onError(error);
    }
  }

  private async tearDownChannelConnection(): Promise<void> {
    if (!this.channelConnection) {
      return;
    }
    const connection = this.channelConnection;
    this.channelConnection = null;
    await this.tearDownConnection(connection);
  }

  private attachDeliveryListener(
    client: RelaycastInboxClient,
    agentId: string,
  ): (() => void) | undefined {
    const { onDeliveryAccepted } = this;
    if (!onDeliveryAccepted || typeof client.onDeliveryAccepted !== "function") {
      return undefined;
    }
    try {
      return client.onDeliveryAccepted((event) => {
        try {
          onDeliveryAccepted(agentId, event);
        } catch (error) {
          void this.onError(error);
        }
      });
    } catch (error) {
      void this.onError(error);
      return undefined;
    }
  }

  private async tearDownConnection(
    connection: {
      subscription: RelaycastInboxSubscription;
      client: RelaycastInboxClient;
      stopDeliveryListener?: () => void;
    },
  ): Promise<void> {
    try {
      connection.stopDeliveryListener?.();
    } catch (error) {
      void this.onError(error);
    }
    try {
      connection.subscription.unsubscribe();
    } catch (error) {
      void this.onError(error);
    }
    try {
      await connection.client.disconnect();
    } catch (error) {
      void this.onError(error);
    }
  }
}

export function createDefaultRelaycastInboxClient(input: {
  accessToken: string;
  baseUrl?: string;
}): RelaycastInboxClient {
  const agent = new AgentClient(
    new HttpClient({
      apiKey: input.accessToken,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    }),
    {
      autoHeartbeatMs: false,
    },
  );

  return {
    subscribe: (channels, onMessage) => agent.subscribe(channels, onMessage),
    // Requires the WebSocket to be connected; the subscriber always calls
    // subscribe() (which connects) before attaching this listener.
    onDeliveryAccepted: (handler) =>
      agent.on.deliveryAccepted((event: DeliveryAcceptedEvent) => {
        handler({ deliveryId: event.deliveryId, messageId: event.messageId });
      }),
    disconnect: () => agent.disconnect(),
  };
}

function resolveRegistration(
  registration: RelaycastInboxRegistration,
): ResolvedRegistration | null {
  const selectors = [...new Set(
    registration.selectors
      .map((selector) => normalizeRegistrationSelector(selector))
      .filter((selector): selector is string => Boolean(selector)),
  )];

  return {
    agentId: registration.agentId,
    accessToken: registration.accessToken,
    channelSelectors: selectors.filter((selector) => selector !== "@self"),
    hasSelf: selectors.includes("@self"),
  };
}

function normalizeRegistrationSelector(selector: string): string | undefined {
  const trimmed = selector.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "@self") {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    return undefined;
  }
  return normalizeRelaycastChannel(trimmed);
}

function normalizeRelaycastChannel(channel: string): string {
  const trimmed = channel.trim();
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

function toInboxEvent(event: RelaycastMessageEvent): RelaycastInboxMessageEvent {
  switch (event.type) {
    case "message.created":
      return {
        id: event.id,
        channel: normalizeRelaycastChannel(event.channel),
        messageId: event.message.id,
        text: event.message.text,
        occurredAt: new Date().toISOString(),
        from: normalizeActor(event.message),
      };
    case "thread.reply":
      return {
        id: event.id,
        channel: normalizeRelaycastChannel(event.channel),
        messageId: event.message.id,
        threadId: event.parentId,
        text: event.message.text,
        occurredAt: new Date().toISOString(),
        from: normalizeActor(event.message),
      };
    case "dm.received":
      return {
        id: event.id,
        channel: `dm:${event.conversationId}`,
        messageId: event.message.id,
        text: event.message.text,
        occurredAt: new Date().toISOString(),
        from: normalizeActor(event.message),
      };
    case "group_dm.received":
      return {
        id: event.id,
        channel: `group-dm:${event.conversationId}`,
        messageId: event.message.id,
        text: event.message.text,
        occurredAt: new Date().toISOString(),
        from: normalizeActor(event.message),
      };
  }
}

function normalizeActor(message: {
  agentId?: string;
  agentName?: string;
}): RelaycastInboxMessageEvent["from"] {
  const id = message.agentId?.trim();
  const displayName = message.agentName?.trim();
  return {
    id: id || displayName || "unknown",
    ...(displayName ? { displayName } : {}),
  };
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}
