import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct WsClientOptions: Equatable, Sendable {
    public var token: String
    public var baseURL: String?
    public var path: String
    public var nodeRegistration: DirectNodeRegistration?
    public var maxReconnectAttempts: Int
    public var reconnectBaseDelayMilliseconds: Int
    public var reconnectMaxDelayMilliseconds: Int
    public var reconnectJitter: Bool
    public var debug: Bool
    public var harness: String?
    public var agentRelayDistinctID: String?
    public var originSurface: String?
    public var originClient: String?
    public var originVersion: String?

    public init(
        token: String,
        baseURL: String? = nil,
        path: String = "/v1/ws",
        nodeRegistration: DirectNodeRegistration? = nil,
        maxReconnectAttempts: Int = 10,
        reconnectBaseDelayMilliseconds: Int = 1_000,
        reconnectMaxDelayMilliseconds: Int = 30_000,
        reconnectJitter: Bool = true,
        debug: Bool = false,
        harness: String? = nil,
        agentRelayDistinctID: String? = nil,
        originSurface: String? = nil,
        originClient: String? = nil,
        originVersion: String? = nil
    ) {
        self.token = token
        self.baseURL = baseURL
        self.path = path
        self.nodeRegistration = nodeRegistration
        self.maxReconnectAttempts = max(0, maxReconnectAttempts)
        self.reconnectBaseDelayMilliseconds = max(1, reconnectBaseDelayMilliseconds)
        self.reconnectMaxDelayMilliseconds = max(reconnectBaseDelayMilliseconds, reconnectMaxDelayMilliseconds)
        self.reconnectJitter = reconnectJitter
        self.debug = debug
        self.harness = harness
        self.agentRelayDistinctID = agentRelayDistinctID
        self.originSurface = originSurface
        self.originClient = originClient
        self.originVersion = originVersion
    }
}

public struct DirectNodeRegistration: Equatable, Sendable {
    public var nodeId: String
    public var name: String
    public var agentName: String

    public init(nodeId: String, name: String, agentName: String) {
        self.nodeId = nodeId
        self.name = name
        self.agentName = agentName
    }
}

public final class RelaycastEventHandlers: @unchecked Sendable {
    private let register: @Sendable (String, @escaping @Sendable (WsEvent) -> Void) -> () -> Void
    private let registerLifecycle: @Sendable (String, @escaping @Sendable (WsLifecycleEvent) -> Void) -> () -> Void

    init(
        register: @escaping @Sendable (String, @escaping @Sendable (WsEvent) -> Void) -> () -> Void,
        registerLifecycle: @escaping @Sendable (String, @escaping @Sendable (WsLifecycleEvent) -> Void) -> () -> Void
    ) {
        self.register = register
        self.registerLifecycle = registerLifecycle
    }

    @discardableResult public func messageCreated(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("message.created", handler) }
    @discardableResult public func messageUpdated(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("message.updated", handler) }
    @discardableResult public func threadReply(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("thread.reply", handler) }
    @discardableResult public func messageRead(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("message.read", handler) }
    @discardableResult public func messageReacted(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("message.reacted", handler) }
    @discardableResult public func dmReceived(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("dm.received", handler) }
    @discardableResult public func groupDMReceived(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("group_dm.received", handler) }
    @discardableResult public func agentStatusChanged(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("agent.status.changed", handler) }
    @discardableResult public func agentActive(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("agent.status.active", handler) }
    @discardableResult public func agentOffline(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("agent.status.offline", handler) }
    @discardableResult public func channelCreated(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("channel.created", handler) }
    @discardableResult public func channelUpdated(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("channel.updated", handler) }
    @discardableResult public func channelArchived(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("channel.archived", handler) }
    @discardableResult public func memberJoined(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("member.joined", handler) }
    @discardableResult public func memberLeft(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("member.left", handler) }
    @discardableResult public func channelMuted(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("member.channel_muted", handler) }
    @discardableResult public func channelUnmuted(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("member.channel_unmuted", handler) }
    @discardableResult public func fileUploaded(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("file.uploaded", handler) }
    @discardableResult public func webhookReceived(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("webhook.received", handler) }
    @discardableResult public func actionInvoked(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("action.invoked", handler) }
    @discardableResult public func actionCompleted(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("action.completed", handler) }
    @discardableResult public func actionFailed(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("action.failed", handler) }
    @discardableResult public func actionDenied(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("action.denied", handler) }
    @discardableResult public func deliveryAccepted(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("delivery.accepted", handler) }
    @discardableResult public func deliveryDelivered(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("delivery.delivered", handler) }
    @discardableResult public func deliveryDeferred(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("delivery.deferred", handler) }
    @discardableResult public func deliveryFailed(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("delivery.failed", handler) }
    @discardableResult public func any(_ handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void { register("*", handler) }

    @discardableResult public func connected(_ handler: @escaping @Sendable () -> Void) -> () -> Void {
        registerLifecycle("open") { _ in handler() }
    }

    @discardableResult public func disconnected(_ handler: @escaping @Sendable () -> Void) -> () -> Void {
        registerLifecycle("close") { _ in handler() }
    }

    @discardableResult public func error(_ handler: @escaping @Sendable (String) -> Void) -> () -> Void {
        registerLifecycle("error") { event in
            if case .error(let message) = event {
                handler(message)
            }
        }
    }

    @discardableResult public func reconnecting(_ handler: @escaping @Sendable (Int) -> Void) -> () -> Void {
        registerLifecycle("reconnecting") { event in
            if case .reconnecting(let attempt) = event {
                handler(attempt)
            }
        }
    }

    @discardableResult public func permanentlyDisconnected(_ handler: @escaping @Sendable (Int) -> Void) -> () -> Void {
        registerLifecycle("permanently_disconnected") { event in
            if case .permanentlyDisconnected(let attempt) = event {
                handler(attempt)
            }
        }
    }
}

public final class WsClient: @unchecked Sendable {
    public lazy var on = RelaycastEventHandlers(
        register: { [weak self] event, handler in
            self?.register(event: event, handler: handler) ?? { }
        },
        registerLifecycle: { [weak self] event, handler in
            self?.registerLifecycle(event: event, handler: handler) ?? { }
        }
    )

    private var options: WsClientOptions
    private let session: URLSession
    private let decoder = makeRelaycastDecoder()
    private let encoder = makeRelaycastEncoder()
    private let lock = NSLock()

    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var handlers: [String: [UUID: @Sendable (WsEvent) -> Void]] = [:]
    private var lifecycleHandlers: [String: [UUID: @Sendable (WsLifecycleEvent) -> Void]] = [:]
    private var desiredChannels = Set<String>()
    private var closed = true
    private var reconnectAttempt = 0

    public var connected: Bool {
        lock.withLock { socket != nil && !closed }
    }

    public init(options: WsClientOptions, session: URLSession = .shared) {
        self.options = options
        self.session = session
    }

    public func configureNodeTransport(token: String, registration: DirectNodeRegistration) {
        lock.withLock {
            options.token = token
            options.path = "/v1/node/ws"
            options.nodeRegistration = registration
        }
    }

    public func reportError(_ message: String) {
        emitLifecycle(.error(message))
    }

    public func connect() {
        lock.lock()
        if socket != nil {
            lock.unlock()
            return
        }
        closed = false
        reconnectTask?.cancel()
        reconnectTask = nil
        lock.unlock()

        openSocket()
    }

    public func disconnect() {
        let socketToCancel: URLSessionWebSocketTask?
        lock.lock()
        closed = true
        socketToCancel = socket
        socket = nil
        receiveTask?.cancel()
        receiveTask = nil
        pingTask?.cancel()
        pingTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        lock.unlock()

        socketToCancel?.cancel(with: .normalClosure, reason: nil)
        emitLifecycle(.close)
    }

    public func subscribe(_ channels: [String]) {
        guard options.nodeRegistration == nil else { return }
        let normalized = channels
            .map { stripHash($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { !$0.isEmpty && $0 != "@self" }
        guard !normalized.isEmpty else { return }

        lock.withLock {
            for channel in normalized {
                desiredChannels.insert(channel)
            }
        }
        send(command: ClientWsCommand(type: "subscribe", channels: normalized))
    }

    public func unsubscribe(_ channels: [String]) {
        guard options.nodeRegistration == nil else { return }
        let normalized = channels
            .map { stripHash($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            .filter { !$0.isEmpty && $0 != "@self" }
        guard !normalized.isEmpty else { return }

        lock.withLock {
            for channel in normalized {
                desiredChannels.remove(channel)
            }
        }
        send(command: ClientWsCommand(type: "unsubscribe", channels: normalized))
    }

    @discardableResult
    public func on(_ event: String, handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void {
        register(event: event, handler: handler)
    }

    private func openSocket() {
        guard let url = websocketURL() else {
            emitLifecycle(.error("Invalid WebSocket URL"))
            return
        }

        let task = session.webSocketTask(with: url)
        lock.withLock {
            socket = task
        }
        task.resume()
        reconnectAttempt = 0
        sendNodeRegisterIfNeeded()
        emitLifecycle(.open)
        startReceiveLoop(task: task)
        startPingLoop()

        let channels = lock.withLock { Array(desiredChannels) }
        if options.nodeRegistration == nil && !channels.isEmpty {
            send(command: ClientWsCommand(type: "subscribe", channels: channels))
        }
    }

    private func startReceiveLoop(task: URLSessionWebSocketTask) {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    self?.handle(message)
                } catch {
                    self?.handleSocketFailure(error)
                    break
                }
            }
        }
    }

    private func startPingLoop() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                self?.sendPing()
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .data(let value):
            data = value
        case .string(let value):
            data = value.data(using: .utf8)
        @unknown default:
            data = nil
        }

        guard let data else { return }
        do {
            if let deliver = try? decoder.decode(NodeDeliverFrame.self, from: data), deliver.type == "deliver" {
                sendNodeDeliveryAck(deliver)
                emit(Self.event(from: deliver))
                return
            }
            if let action = try? decoder.decode(NodeActionInvokeFrame.self, from: data), action.type == "action.invoke" {
                emit(Self.event(from: action))
                return
            }
            if let context = try? decoder.decode(NodeContextUpdateFrame.self, from: data), context.type == "context.update" {
                emit(Self.event(from: context))
                return
            }
            let event = try decoder.decode(WsEvent.self, from: data)
            emit(event)
        } catch {
            if options.debug {
                emitLifecycle(.error("Dropped malformed WebSocket message"))
            }
        }
    }

    private func handleSocketFailure(_ error: Error) {
        let shouldReconnect = lock.withLock { !closed }
        guard shouldReconnect else { return }

        lock.withLock {
            socket = nil
            receiveTask = nil
            pingTask?.cancel()
            pingTask = nil
        }

        emitLifecycle(.close)
        scheduleReconnect(error: error)
    }

    private func scheduleReconnect(error: Error) {
        lock.lock()
        guard reconnectTask == nil else {
            lock.unlock()
            return
        }

        if reconnectAttempt >= options.maxReconnectAttempts {
            let attempt = reconnectAttempt
            closed = true
            lock.unlock()
            emitLifecycle(.error(error.localizedDescription))
            emitLifecycle(.permanentlyDisconnected(attempt: attempt))
            return
        }

        reconnectAttempt += 1
        let attempt = reconnectAttempt
        lock.unlock()

        emitLifecycle(.reconnecting(attempt: attempt))
        reconnectTask = Task { [weak self] in
            let delay = self?.reconnectDelayMilliseconds(attempt: attempt) ?? 1_000
            try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000)
            guard let self else { return }
            self.lock.withLock {
                self.reconnectTask = nil
            }
            self.openSocket()
        }
    }

    private func reconnectDelayMilliseconds(attempt: Int) -> Int {
        let base = Double(options.reconnectBaseDelayMilliseconds)
        let exponential = min(Double(options.reconnectMaxDelayMilliseconds), base * pow(2, Double(max(0, attempt - 1))))
        let jitter = options.reconnectJitter ? Double.random(in: 0.5...1.5) : 1
        return max(1, Int((exponential * jitter).rounded()))
    }

    private func sendPing() {
        if let registration = options.nodeRegistration {
            let heartbeat: [String: JSONValue] = [
                "v": 1,
                "type": "node.heartbeat",
                "load": 1,
                "load_reported": true,
                "active_agents": 1,
                "handlers_live": false,
                "node_id": .string(registration.nodeId),
                "name": .string(registration.name),
                "capabilities": [],
                "max_agents": 1,
                "version": .string(relaycastSDKVersion)
            ]
            send(json: heartbeat)
            return
        }
        send(raw: #"{"type":"ping"}"#)
    }

    private func sendNodeRegisterIfNeeded() {
        guard let registration = options.nodeRegistration else { return }
        let frame: [String: JSONValue] = [
            "v": 1,
            "id": .string("register-\(registration.nodeId)"),
            "type": "node.register",
            "node_id": .string(registration.nodeId),
            "name": .string(registration.name),
            "capabilities": [],
            "max_agents": 1,
            "tags": ["implicit", "direct", "sdk"],
            "version": .string(relaycastSDKVersion),
            "resume_cursor": .null
        ]
        send(json: frame)
    }

    private func sendNodeDeliveryAck(_ deliver: NodeDeliverFrame) {
        let frame: [String: JSONValue] = [
            "v": 1,
            "type": "delivery.ack",
            "agent": .string(deliver.agent),
            "up_to_seq": .int(deliver.seq)
        ]
        send(json: frame)
    }

    private func send(command: ClientWsCommand) {
        do {
            let data = try encoder.encode(command)
            guard let raw = String(data: data, encoding: .utf8) else { return }
            send(raw: raw)
        } catch {
            emitLifecycle(.error(error.localizedDescription))
        }
    }

    private func send(raw: String) {
        let task = lock.withLock { socket }
        task?.send(.string(raw)) { [weak self] error in
            if let error {
                self?.emitLifecycle(.error(error.localizedDescription))
            }
        }
    }

    private func send(json: [String: JSONValue]) {
        do {
            let data = try encoder.encode(json)
            guard let raw = String(data: data, encoding: .utf8) else { return }
            send(raw: raw)
        } catch {
            emitLifecycle(.error(error.localizedDescription))
        }
    }

    private func websocketURL() -> URL? {
        let rawBase = (options.baseURL ?? "https://cast.agentrelay.com")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")

        guard var components = URLComponents(string: "\(rawBase)\(options.path)") else {
            return nil
        }

        var items = [
            URLQueryItem(name: "token", value: options.token),
            URLQueryItem(name: "origin_surface", value: options.originSurface ?? RelaycastOrigin.surface),
            URLQueryItem(name: "origin_client", value: options.originClient ?? RelaycastOrigin.client),
            URLQueryItem(name: "origin_version", value: options.originVersion ?? RelaycastOrigin.version)
        ]
        if let harness = sanitizeHarness(options.harness) {
            items.append(URLQueryItem(name: "harness", value: harness))
        }
        if let agentRelayDistinctID = sanitizeAgentRelayDistinctID(options.agentRelayDistinctID) {
            items.append(URLQueryItem(name: agentRelayDistinctIDQuery, value: agentRelayDistinctID))
        }
        components.queryItems = items
        return components.url
    }

    private func register(event: String, handler: @escaping @Sendable (WsEvent) -> Void) -> () -> Void {
        let id = UUID()
        lock.withLock {
            handlers[event, default: [:]][id] = handler
        }
        return { [weak self] in
            self?.lock.withLock {
                self?.handlers[event]?[id] = nil
            }
        }
    }

    private func registerLifecycle(event: String, handler: @escaping @Sendable (WsLifecycleEvent) -> Void) -> () -> Void {
        let id = UUID()
        lock.withLock {
            lifecycleHandlers[event, default: [:]][id] = handler
        }
        return { [weak self] in
            self?.lock.withLock {
                self?.lifecycleHandlers[event]?[id] = nil
            }
        }
    }

    private func emit(_ event: WsEvent) {
        let callbacks = lock.withLock {
            Array((handlers[event.type] ?? [:]).values) + Array((handlers["*"] ?? [:]).values)
        }
        for callback in callbacks {
            callback(event)
        }
    }

    private func emitLifecycle(_ event: WsLifecycleEvent) {
        let name: String
        switch event {
        case .open:
            name = "open"
        case .close:
            name = "close"
        case .error:
            name = "error"
        case .reconnecting:
            name = "reconnecting"
        case .permanentlyDisconnected:
            name = "permanently_disconnected"
        }

        let callbacks = lock.withLock { Array((lifecycleHandlers[name] ?? [:]).values) }
        for callback in callbacks {
            callback(event)
        }
    }
}

private struct NodeDeliverFrame: Codable {
    let type: String
    let deliveryId: String
    let agent: String
    let msgId: String
    let seq: Int
    let payload: NodeDeliverPayload
}

private struct NodeDeliverPayload: Codable {
    let type: String
    let data: [String: JSONValue]
}

private struct NodeActionInvokeFrame: Codable {
    let type: String
    let invocationId: String
    let action: String
    let agentId: String?
    let agentName: String?
    let input: JSONValue?
}

private struct NodeContextUpdateFrame: Codable {
    let type: String
    let event: String
    let data: [String: JSONValue]
}

private extension WsClient {
    static func event(from deliver: NodeDeliverFrame) -> WsEvent {
        let type = deliver.payload.type
        let data = deliver.payload.data
        switch type {
        case "message.created":
            return WsEvent(type: type, payload: [
                "channel": stringValue(data["channel_name"]).map(JSONValue.string) ?? .string(""),
                "message": .object([
                    "id": data["id"] ?? .null,
                    "agent_id": data["agent_id"] ?? .null,
                    "agent_name": data["agent_name"] ?? data["from_name"] ?? .string("unknown"),
                    "text": data["text"] ?? .string(""),
                    "attachments": data["attachments"] ?? .array([]),
                    "injection_mode": data["injection_mode"] ?? .null
                ])
            ])
        case "thread.reply":
            return WsEvent(type: type, payload: [
                "channel": stringValue(data["channel_name"]).map(JSONValue.string) ?? .string(""),
                "parent_id": data["thread_id"] ?? .null,
                "message": .object([
                    "id": data["id"] ?? .null,
                    "agent_id": data["agent_id"] ?? .null,
                    "agent_name": data["agent_name"] ?? data["from_name"] ?? .string("unknown"),
                    "text": data["text"] ?? .string("")
                ])
            ])
        default:
            return WsEvent(type: type, payload: data)
        }
    }

    static func event(from action: NodeActionInvokeFrame) -> WsEvent {
        WsEvent(type: "action.invoked", payload: [
            "invocation_id": .string(action.invocationId),
            "action_name": .string(action.action),
            "caller_name": .string("node"),
            "handler_agent_id": .string(action.agentId ?? ""),
            "handler_agent_name": action.agentName.map(JSONValue.string) ?? .null,
            "input": action.input ?? .object([:])
        ])
    }

    static func event(from context: NodeContextUpdateFrame) -> WsEvent {
        WsEvent(type: context.event, payload: context.data)
    }

    static func stringValue(_ value: JSONValue?) -> String? {
        if case .string(let raw)? = value {
            return raw
        }
        return nil
    }
}

private struct ClientWsCommand: Codable {
    let type: String
    let channels: [String]
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
