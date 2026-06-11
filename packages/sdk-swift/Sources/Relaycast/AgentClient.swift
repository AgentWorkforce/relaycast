import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct AgentClientOptions: Equatable, Sendable {
    public var autoHeartbeatMilliseconds: Int?
    public var ws: RelayCastWebSocketOptions

    public init(autoHeartbeatMilliseconds: Int? = 30_000, ws: RelayCastWebSocketOptions = RelayCastWebSocketOptions()) {
        self.autoHeartbeatMilliseconds = autoHeartbeatMilliseconds
        self.ws = ws
    }
}

public struct SendMessageOptions: Equatable, Sendable {
    public var attachments: [String]?
    public var blocks: [MessageBlock]?
    public var mode: MessageInjectionMode
    public var idempotencyKey: String?

    public init(
        attachments: [String]? = nil,
        blocks: [MessageBlock]? = nil,
        mode: MessageInjectionMode = .wait,
        idempotencyKey: String? = nil
    ) {
        self.attachments = attachments
        self.blocks = blocks
        self.mode = mode
        self.idempotencyKey = idempotencyKey
    }
}

public struct ReplyOptions: Equatable, Sendable {
    public var blocks: [MessageBlock]?
    public var idempotencyKey: String?

    public init(blocks: [MessageBlock]? = nil, idempotencyKey: String? = nil) {
        self.blocks = blocks
        self.idempotencyKey = idempotencyKey
    }
}

public struct InboxOptions: Equatable, Sendable {
    public var limit: Int?

    public init(limit: Int? = nil) {
        self.limit = limit
    }
}

public struct EnsureChannelOutcome: Equatable, Sendable {
    public let name: String
    public let created: Bool
    public let joined: Bool
}

public struct Subscription: Sendable {
    public let channels: [String]
    private let unsubscribeHandler: @Sendable () -> Void

    init(channels: [String], unsubscribeHandler: @escaping @Sendable () -> Void) {
        self.channels = channels
        self.unsubscribeHandler = unsubscribeHandler
    }

    public func unsubscribe() {
        unsubscribeHandler()
    }
}

public final class AgentPresenceService: @unchecked Sendable {
    private unowned let agent: AgentClient

    init(agent: AgentClient) {
        self.agent = agent
    }

    public func markOnline() async throws {
        let _: EmptyResponse = try await agent.client.post("/v1/agents/heartbeat", body: EmptyRequest())
    }

    public func heartbeat() async throws {
        try await markOnline()
    }

    public func markOffline() async throws {
        agent.stopAutoHeartbeat()
        let _: EmptyResponse = try await agent.client.post("/v1/agents/disconnect", body: EmptyRequest())
    }
}

public final class AgentClient: @unchecked Sendable {
    public let client: HttpClient
    public lazy var presence = AgentPresenceService(agent: self)

    private let options: AgentClientOptions
    private var ws: WsClient?
    private var autoHeartbeatTask: Task<Void, Never>?
    private var manualSubscriptions = Set<String>()

    public lazy var on = RelaycastEventHandlers(
        register: { [weak self] event, handler in
            self?.webSocket().on(event, handler: handler) ?? { }
        },
        registerLifecycle: { [weak self] event, handler in
            guard let self else { return { } }
            switch event {
            case "open":
                return self.webSocket().on.connected { handler(.open) }
            case "close":
                return self.webSocket().on.disconnected { handler(.close) }
            case "error":
                return self.webSocket().on.error { message in handler(.error(message)) }
            case "reconnecting":
                return self.webSocket().on.reconnecting { attempt in handler(.reconnecting(attempt: attempt)) }
            case "permanently_disconnected":
                return self.webSocket().on.permanentlyDisconnected { attempt in handler(.permanentlyDisconnected(attempt: attempt)) }
            default:
                return { }
            }
        }
    )
    public lazy var dms = AgentDMService(agent: self)
    public lazy var channels = AgentChannelsService(agent: self)
    public lazy var actions = AgentActionsService(agent: self)
    public lazy var files = AgentFilesService(agent: self)

    public init(token: String, baseURL: String? = nil, options: AgentClientOptions = AgentClientOptions(), session: URLSession = .shared) throws {
        self.client = try HttpClient(options: ClientOptions(apiKey: token, baseURL: baseURL), session: session)
        self.options = options
    }

    init(client: HttpClient, options: AgentClientOptions = AgentClientOptions()) throws {
        self.client = client
        self.options = options
    }

    public func me() async throws -> Agent {
        try await client.get("/v1/agent")
    }

    public func connect() {
        let socket = webSocket()
        socket.on.connected { [weak self] in
            guard let self else { return }
            Task {
                try? await self.presence.markOnline()
                self.startAutoHeartbeat()
                let channels = Array(self.manualSubscriptions)
                if !channels.isEmpty {
                    self.ws?.subscribe(channels)
                }
            }
        }
        socket.on.disconnected { [weak self] in
            self?.stopAutoHeartbeat()
        }
        socket.on.permanentlyDisconnected { [weak self] _ in
            self?.stopAutoHeartbeat()
        }
        socket.connect()
    }

    public func heartbeat() async throws {
        try await presence.heartbeat()
    }

    public func disconnect() async {
        stopAutoHeartbeat()
        ws?.disconnect()
        ws = nil
        manualSubscriptions.removeAll()
        try? await presence.markOffline()
    }

    public func subscribe(_ channels: [String]) {
        let normalized = normalizedSubscriptionChannels(channels)
        for channel in normalized where channel != "@self" {
            manualSubscriptions.insert(channel)
        }
        webSocket().subscribe(normalized)
    }

    public func subscribe(_ channels: [String], onMessage: @escaping @Sendable (WsEvent) -> Void) -> Subscription {
        let normalized = normalizedSubscriptionChannels(channels)
        connect()
        subscribe(normalized)
        let stops = [
            on.messageCreated { event in if Self.event(event, matches: normalized) { onMessage(event) } },
            on.threadReply { event in if Self.event(event, matches: normalized) { onMessage(event) } },
            on.dmReceived { event in if Self.event(event, matches: normalized) { onMessage(event) } },
            on.groupDMReceived { event in if Self.event(event, matches: normalized) { onMessage(event) } }
        ]
        return Subscription(channels: normalized) {
            for stop in stops {
                stop()
            }
        }
    }

    public func unsubscribe(_ channels: [String]) {
        let normalized = normalizedSubscriptionChannels(channels)
        for channel in normalized {
            manualSubscriptions.remove(channel)
        }
        webSocket().unsubscribe(normalized)
    }

    public func send(_ channel: String, text: String, options: SendMessageOptions = SendMessageOptions()) async throws -> MessageWithMeta {
        let name = stripHash(channel)
        let body = PostMessageRequest(
            text: text,
            blocks: options.blocks,
            attachments: options.attachments,
            mode: options.mode
        )
        return try await client.post(
            "/v1/channels/\(percentEncodePathComponent(name))/messages",
            body: body,
            options: RequestOptions(idempotencyKey: options.idempotencyKey)
        )
    }

    public func post(_ channel: String, text: String, options: SendMessageOptions = SendMessageOptions()) async throws -> MessageWithMeta {
        try await send(channel, text: text, options: options)
    }

    public func messages(_ channel: String, options: MessageListQuery = MessageListQuery()) async throws -> [MessageWithMeta] {
        let name = stripHash(channel)
        return try await client.get("/v1/channels/\(percentEncodePathComponent(name))/messages", query: options.queryItems)
    }

    public func message(_ id: String) async throws -> MessageWithMeta {
        try await client.get("/v1/messages/\(percentEncodePathComponent(id))")
    }

    public func reply(_ id: String, text: String, options: ReplyOptions = ReplyOptions()) async throws -> MessageWithMeta {
        let body = ThreadReplyRequest(text: text, blocks: options.blocks)
        return try await client.post(
            "/v1/messages/\(percentEncodePathComponent(id))/replies",
            body: body,
            options: RequestOptions(idempotencyKey: options.idempotencyKey)
        )
    }

    public func thread(_ id: String, options: MessageListQuery = MessageListQuery()) async throws -> ThreadResponse {
        try await client.get("/v1/messages/\(percentEncodePathComponent(id))/replies", query: options.queryItems)
    }

    public func dm(_ agent: String, text: String, options: DMOptions = DMOptions()) async throws -> SendDMResponse {
        try await client.post(
            "/v1/dm",
            body: SendDMRequest(to: agent, text: text, attachments: options.attachments, mode: options.mode),
            options: RequestOptions(idempotencyKey: options.idempotencyKey)
        )
    }

    public func react(messageID: String, emoji: String) async throws -> AddedReaction {
        try await client.post("/v1/messages/\(percentEncodePathComponent(messageID))/reactions", body: ReactionRequest(emoji: emoji))
    }

    public func unreact(messageID: String, emoji: String) async throws {
        _ = try await client.delete("/v1/messages/\(percentEncodePathComponent(messageID))/reactions/\(percentEncodePathComponent(emoji))")
    }

    public func reactions(messageID: String) async throws -> [ReactionGroup] {
        try await client.get("/v1/messages/\(percentEncodePathComponent(messageID))/reactions")
    }

    public func search(_ query: String, options: SearchOptions = SearchOptions()) async throws -> [SearchMessageResult] {
        var params: [String: String] = ["q": query]
        if let channel = options.channel { params["channel"] = channel }
        if let from = options.from { params["from"] = from }
        if let limit = options.limit { params["limit"] = String(limit) }
        if let before = options.before { params["before"] = before }
        if let after = options.after { params["after"] = after }
        return try await client.get("/v1/search", query: params)
    }

    public func inbox(options: InboxOptions = InboxOptions()) async throws -> InboxResponse {
        var params: [String: String] = [:]
        if let limit = options.limit { params["limit"] = String(limit) }
        return try await client.get("/v1/inbox", query: params)
    }

    public func markRead(messageID: String) async throws -> ReadReceipt {
        try await client.post("/v1/messages/\(percentEncodePathComponent(messageID))/read", body: EmptyRequest())
    }

    public func readers(messageID: String) async throws -> [ReaderInfo] {
        try await client.get("/v1/messages/\(percentEncodePathComponent(messageID))/readers")
    }

    public func readStatus(channel: String) async throws -> [ChannelReadStatus] {
        try await client.get("/v1/channels/\(percentEncodePathComponent(stripHash(channel)))/read-status")
    }

    public func deliveries(options: ListDeliveriesOptions = ListDeliveriesOptions()) async throws -> [DeliveryItem] {
        var params: [String: String] = [:]
        if let status = options.status { params["status"] = status.rawValue }
        if let limit = options.limit { params["limit"] = String(limit) }
        return try await client.get("/v1/deliveries", query: params)
    }

    public func ackDelivery(_ deliveryID: String) async throws -> Delivery {
        try await client.post("/v1/deliveries/\(percentEncodePathComponent(deliveryID))/ack", body: EmptyRequest())
    }

    public func failDelivery(_ deliveryID: String, options: FailDeliveryRequest = FailDeliveryRequest()) async throws -> Delivery {
        try await client.post("/v1/deliveries/\(percentEncodePathComponent(deliveryID))/fail", body: options)
    }

    public func deferDelivery(_ deliveryID: String, options: DeferDeliveryRequest) async throws -> Delivery {
        try await client.post("/v1/deliveries/\(percentEncodePathComponent(deliveryID))/defer", body: options)
    }

    private func webSocket() -> WsClient {
        if let ws {
            return ws
        }
        let socket = WsClient(
            options: WsClientOptions(
                token: client.apiKey,
                baseURL: client.baseURL.absoluteString,
                maxReconnectAttempts: options.ws.maxReconnectAttempts,
                reconnectBaseDelayMilliseconds: options.ws.reconnectBaseDelayMilliseconds,
                reconnectMaxDelayMilliseconds: options.ws.reconnectMaxDelayMilliseconds,
                reconnectJitter: options.ws.reconnectJitter,
                debug: options.ws.debug,
                harness: client.harness,
                agentRelayDistinctID: client.agentRelayDistinctID,
                originSurface: client.originSurface,
                originClient: client.originClient,
                originVersion: client.originVersion
            )
        )
        ws = socket
        return socket
    }

    private func normalizedSubscriptionChannels(_ channels: [String]) -> [String] {
        Array(Set(channels.map {
            let trimmed = $0.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed == "@self" ? trimmed : stripHash(trimmed)
        }.filter { !$0.isEmpty }))
    }

    private static func event(_ event: WsEvent, matches channels: [String]) -> Bool {
        switch event.type {
        case "dm.received", "group_dm.received":
            return channels.contains("@self")
        case "message.created", "thread.reply":
            if case .string(let channel)? = event.payload["channel"] {
                return channels.contains(stripHash(channel))
            }
            return false
        default:
            return false
        }
    }

    fileprivate func startAutoHeartbeat() {
        stopAutoHeartbeat()
        guard let interval = options.autoHeartbeatMilliseconds, interval > 0 else {
            return
        }
        autoHeartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000)
                try? await self?.presence.heartbeat()
            }
        }
    }

    fileprivate func stopAutoHeartbeat() {
        autoHeartbeatTask?.cancel()
        autoHeartbeatTask = nil
    }
}

public final class AgentDMService: @unchecked Sendable {
    private unowned let agent: AgentClient

    init(agent: AgentClient) {
        self.agent = agent
    }

    public func conversations() async throws -> [DMConversationSummary] {
        try await agent.client.get("/v1/dm/conversations")
    }

    public func messages(conversationID: String, options: MessageListQuery = MessageListQuery()) async throws -> [DMMessage] {
        try await agent.client.get("/v1/dm/\(percentEncodePathComponent(conversationID))/messages", query: options.queryItems)
    }

    public func createGroup(_ request: CreateGroupDMRequest, idempotencyKey: String? = nil) async throws -> CreateGroupDMResponse {
        try await agent.client.post("/v1/dm/group", body: request, options: RequestOptions(idempotencyKey: idempotencyKey))
    }

    public func sendMessage(conversationID: String, text: String, options: DMOptions = DMOptions()) async throws -> GroupDMMessageResponse {
        try await agent.client.post(
            "/v1/dm/\(percentEncodePathComponent(conversationID))/messages",
            body: GroupDMSendRequest(text: text, attachments: options.attachments, mode: options.mode),
            options: RequestOptions(idempotencyKey: options.idempotencyKey)
        )
    }

    public func addParticipant(conversationID: String, agent name: String) async throws -> GroupDMParticipantResponse {
        try await agent.client.post(
            "/v1/dm/\(percentEncodePathComponent(conversationID))/participants",
            body: AgentNameRequest(agentName: name)
        )
    }

    public func removeParticipant(conversationID: String, agent name: String) async throws {
        _ = try await agent.client.delete("/v1/dm/\(percentEncodePathComponent(conversationID))/participants/\(percentEncodePathComponent(name))")
    }
}

public final class AgentChannelsService: @unchecked Sendable {
    private unowned let agent: AgentClient

    init(agent: AgentClient) {
        self.agent = agent
    }

    public func create(_ data: CreateChannelRequest) async throws -> Channel {
        try await agent.client.post("/v1/channels", body: data)
    }

    public func list(_ options: ChannelListOptions = ChannelListOptions()) async throws -> [Channel] {
        var query: [String: String] = [:]
        if options.includeArchived { query["includeArchived"] = "true" }
        return try await agent.client.get("/v1/channels", query: query)
    }

    public func get(_ name: String) async throws -> ChannelWithMembers {
        try await agent.client.get("/v1/channels/\(percentEncodePathComponent(name))")
    }

    public func join(_ name: String) async throws -> JoinChannelResponse {
        try await agent.client.post("/v1/channels/\(percentEncodePathComponent(name))/join", body: EmptyRequest())
    }

    public func leave(_ name: String) async throws {
        let _: EmptyResponse = try await agent.client.post("/v1/channels/\(percentEncodePathComponent(name))/leave", body: EmptyRequest())
    }

    public func setTopic(_ name: String, topic: String) async throws -> Channel {
        try await agent.client.patch("/v1/channels/\(percentEncodePathComponent(name))/topic", body: TopicRequest(topic: topic))
    }

    public func archive(_ name: String) async throws {
        _ = try await agent.client.delete("/v1/channels/\(percentEncodePathComponent(name))")
    }

    public func invite(channel: String, agent name: String) async throws -> InviteChannelResponse {
        try await agent.client.post("/v1/channels/\(percentEncodePathComponent(channel))/invite", body: AgentNameRequest(agentName: name))
    }

    public func members(_ name: String) async throws -> [ChannelMemberInfo] {
        try await agent.client.get("/v1/channels/\(percentEncodePathComponent(name))/members")
    }

    public func update(_ name: String, data: UpdateChannelRequest) async throws -> Channel {
        try await agent.client.patch("/v1/channels/\(percentEncodePathComponent(name))", body: data)
    }

    public func mute(_ name: String) async throws {
        let _: EmptyResponse = try await agent.client.post("/v1/channels/\(percentEncodePathComponent(name))/mute", body: EmptyRequest())
    }

    public func unmute(_ name: String) async throws {
        let _: EmptyResponse = try await agent.client.post("/v1/channels/\(percentEncodePathComponent(name))/unmute", body: EmptyRequest())
    }

    public func ensureJoinedChannel(_ request: CreateChannelRequest) async throws -> EnsureChannelOutcome {
        var created = false
        do {
            _ = try await create(request)
            created = true
        } catch let error as RelayError {
            if error.statusCode != 409 {
                throw error
            }
        }
        _ = try await join(request.name)
        return EnsureChannelOutcome(name: request.name, created: created, joined: true)
    }
}

public final class AgentActionsService: @unchecked Sendable {
    private unowned let agent: AgentClient

    init(agent: AgentClient) {
        self.agent = agent
    }

    public func invoke(_ name: String, input: [String: JSONValue] = [:]) async throws -> InvokeActionResult {
        try await agent.client.post("/v1/actions/\(percentEncodePathComponent(name))/invoke", body: InvokeActionRequest(input: input))
    }

    public func completeInvocation(name: String, invocationID: String, data: CompleteInvocationRequest) async throws -> ActionInvocation {
        try await agent.client.post(
            "/v1/actions/\(percentEncodePathComponent(name))/invocations/\(percentEncodePathComponent(invocationID))/complete",
            body: data
        )
    }

    public func getInvocation(name: String, invocationID: String) async throws -> ActionInvocation {
        try await agent.client.get("/v1/actions/\(percentEncodePathComponent(name))/invocations/\(percentEncodePathComponent(invocationID))")
    }
}

public final class AgentFilesService: @unchecked Sendable {
    private unowned let agent: AgentClient

    init(agent: AgentClient) {
        self.agent = agent
    }

    public func upload(_ data: UploadRequest) async throws -> UploadResponse {
        try await agent.client.post("/v1/files/upload", body: data)
    }

    public func complete(fileID: String) async throws -> CompleteUploadResponse {
        try await agent.client.post("/v1/files/\(percentEncodePathComponent(fileID))/complete", body: EmptyRequest())
    }

    public func get(fileID: String) async throws -> FileInfo {
        try await agent.client.get("/v1/files/\(percentEncodePathComponent(fileID))")
    }

    public func delete(fileID: String) async throws {
        _ = try await agent.client.delete("/v1/files/\(percentEncodePathComponent(fileID))")
    }

    public func list(_ options: FileListOptions = FileListOptions()) async throws -> [FileInfo] {
        var query: [String: String] = [:]
        if let uploadedBy = options.uploadedBy { query["uploadedBy"] = uploadedBy }
        if let limit = options.limit { query["limit"] = String(limit) }
        return try await agent.client.get("/v1/files", query: query)
    }
}

private struct ReactionRequest: Codable {
    var emoji: String
}

private struct AgentNameRequest: Codable {
    var agentName: String
}

private struct TopicRequest: Codable {
    var topic: String
}

private struct GroupDMSendRequest: Codable {
    var text: String
    var attachments: [String]?
    var mode: MessageInjectionMode
}

private struct InvokeActionRequest: Codable {
    var input: [String: JSONValue]
}
