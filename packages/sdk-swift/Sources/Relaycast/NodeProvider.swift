import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// A node provider client: it attaches a process to a node, registers a subset
// of that node's capabilities against the engine's `/v1/node/ws`, and executes
// their invokes. Connection, registration, heartbeats, invoke dispatch, and
// the handler-context helpers (`sendMessage`/`spawnAgent`) live here, with no
// local-broker dependency.
//
// Enrollment (reading the node token/URL from disk) layers on top of this in
// a thin wrapper; the client itself takes an explicit token and base URL.

// MARK: - Capability registration

public enum CapabilityKind: String, Sendable, Equatable, CaseIterable {
    case action
    case capacity
}

public typealias NodeActionHandler = @Sendable (JSONValue, NodeHandlerContext) async throws -> JSONValue

private struct RegisteredCapability {
    let kind: CapabilityKind?
    let global: Bool
    let queue: Bool
    let metadata: [String: JSONValue]?
    let handler: NodeActionHandler
}

// MARK: - Handler context

public enum NodeMessageMode: String, Sendable, Equatable {
    case wait
    case steer
}

/// Context passed to every capability handler.
public struct NodeHandlerContext: Sendable {
    public struct NodeInfo: Sendable {
        public let name: String
        public let capabilities: [String]

        public init(name: String, capabilities: [String]) {
            self.name = name
            self.capabilities = capabilities
        }
    }

    /// Informational view of the node this provider is attached to.
    public let node: NodeInfo
    /// The invocation being handled.
    public let invocationID: String

    private let sendMessageImpl: @Sendable (String, String, String, NodeMessageMode?, [String: JSONValue]?) async throws -> JSONValue
    private let spawnAgentImpl: @Sendable ([String: JSONValue]) async throws -> JSONValue

    init(
        node: NodeInfo,
        invocationID: String,
        sendMessageImpl: @escaping @Sendable (String, String, String, NodeMessageMode?, [String: JSONValue]?) async throws -> JSONValue,
        spawnAgentImpl: @escaping @Sendable ([String: JSONValue]) async throws -> JSONValue
    ) {
        self.node = node
        self.invocationID = invocationID
        self.sendMessageImpl = sendMessageImpl
        self.spawnAgentImpl = spawnAgentImpl
    }

    /// Post a top-level channel message, attributed to `from` (an agent name
    /// resolved in the workspace). Resolves with the posted message. Thread
    /// replies are not part of this surface.
    public func sendMessage(
        to: String,
        from: String,
        text: String,
        mode: NodeMessageMode? = nil,
        data: [String: JSONValue]? = nil
    ) async throws -> JSONValue {
        try await sendMessageImpl(to, from, text, mode, data)
    }

    /// Spawn an agent through the node's capacity executor. Capacity-direct: it
    /// never re-enters action dispatch, so a `spawn:<harness>` shadow handler
    /// that delegates cannot recurse into itself. The spawn spec is a JSON
    /// object (the engine's `node.spawn` input is object-typed). Resolves with
    /// the spawn placement.
    public func spawnAgent(_ input: [String: JSONValue]) async throws -> JSONValue {
        try await spawnAgentImpl(input)
    }
}

// MARK: - Registration result / errors

public struct NodeCapabilityAcceptance: Equatable, Sendable {
    public let name: String
    public let kind: String
    public let accepted: Bool
    public let reason: String?
}

/// `node.register` reply data. Carries the resolved provider identity and
/// per-capability acceptance alongside the node's public descriptor (passed
/// through in `raw`).
public struct NodeRegisterReplyData: Equatable, Sendable {
    public let providerName: String
    public let instanceID: String
    public let acceptedCapabilities: [NodeCapabilityAcceptance]
    public let raw: JSONValue

    static func parse(_ json: JSONValue) throws -> NodeRegisterReplyData {
        // A malformed reply is a deterministic registration failure (thrown as a
        // NodeRegistrationError so it hard-fails rather than being retried as a
        // transient drop).
        guard case .object(let obj) = json,
              case .object(let providerObj)? = obj["provider"],
              case .string(let name)? = providerObj["name"],
              case .string(let instanceID)? = providerObj["instance_id"]
        else {
            throw NodeRegistrationError(code: "invalid_register_reply", message: "node.register reply is malformed")
        }

        // The reply must carry a well-formed acceptance list (the engine always
        // does). A missing/corrupt list means acceptance can't be confirmed, so
        // fail registration rather than assume success.
        guard case .array(let items)? = obj["accepted_capabilities"] else {
            throw NodeRegistrationError(code: "invalid_register_reply", message: "node.register reply is missing accepted_capabilities")
        }
        let acceptedCapabilities: [NodeCapabilityAcceptance] = items.map { item -> NodeCapabilityAcceptance in
            // A malformed entry can't be confirmed accepted — count it as
            // rejected (fail-safe) rather than dropping it.
            guard case .object(let capObj) = item, case .string(let capName)? = capObj["name"] else {
                return NodeCapabilityAcceptance(name: "<unknown>", kind: "action", accepted: false, reason: "malformed acceptance entry")
            }
            let accepted: Bool = { if case .bool(let a)? = capObj["accepted"] { return a } else { return false } }()
            let kind: String = { if case .string(let k)? = capObj["kind"] { return k } else { return "action" } }()
            let reason: String? = { if case .string(let r)? = capObj["reason"] { return r } else { return nil } }()
            return NodeCapabilityAcceptance(name: capName, kind: kind, accepted: accepted, reason: reason)
        }

        return NodeRegisterReplyData(providerName: name, instanceID: instanceID, acceptedCapabilities: acceptedCapabilities, raw: json)
    }
}

/// Thrown when the engine rejects the provider's registration (a capability
/// was rejected, or the engine sent an `error` frame such as
/// `provider_instance_conflict`).
public struct NodeRegistrationError: Error, LocalizedError, Sendable, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public enum NodeProviderError: Error, LocalizedError, Sendable, Equatable {
    case notConnected
    case stopped
    case connectionClosed
    case reconnectAttemptsExhausted
    case encodingFailed
    case invalidRegisterReply

    public var errorDescription: String? {
        switch self {
        case .notConnected: return "node provider websocket is not open"
        case .stopped: return "node provider stopped"
        case .connectionClosed: return "node provider connection closed"
        case .reconnectAttemptsExhausted: return "node provider exhausted reconnect attempts"
        case .encodingFailed: return "failed to encode node provider frame"
        case .invalidRegisterReply: return "node provider received an invalid node.register reply"
        }
    }
}

// MARK: - Transport abstraction

/// Abstracts the node socket so `NodeProvider` is unit-testable without a real
/// network connection. `incoming` yields inbound text frames and finishes when
/// the connection closes, expectedly or not.
public protocol NodeTransport: Sendable {
    func send(_ text: String) async throws
    var incoming: AsyncStream<String> { get }
    func close() async
}

/// The production transport: a `URLSessionWebSocketTask` bridged into
/// `NodeTransport`'s async-stream shape.
public final class URLSessionNodeTransport: NodeTransport, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let receiveTask: Task<Void, Never>
    public let incoming: AsyncStream<String>

    public init(url: URL, session: URLSession = .shared) {
        let task = session.webSocketTask(with: url)
        self.task = task
        let (stream, continuation) = AsyncStream<String>.makeStream(of: String.self)
        self.incoming = stream
        task.resume()
        self.receiveTask = Task {
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    switch message {
                    case .string(let text):
                        continuation.yield(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            continuation.yield(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    continuation.finish()
                    return
                }
            }
            continuation.finish()
        }
    }

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    public func close() async {
        receiveTask.cancel()
        task.cancel(with: .normalClosure, reason: nil)
    }
}

// MARK: - NodeProvider

/// A node provider client. Connects to `<baseURL>/v1/node/ws`, registers its
/// capabilities, and dispatches `action.invoke` frames to their handlers until
/// stopped. Reconnects with backoff on unexpected drops, minting a fresh
/// `instanceID` per connection (the engine's replace semantic).
public actor NodeProvider {
    private enum RegistrationState {
        case pending
        case resolved(NodeRegisterReplyData)
        case rejected(Error)
    }

    private enum ConnectionOutcome {
        case stoppedGracefully
        case registrationRejected(Error)
        case droppedUnexpectedly
    }

    private let baseURL: String
    private let nodeToken: String
    private let nodeID: String
    private let nodeName: String
    private let providerName: String
    private let initialInstanceID: String?
    private let maxAgents: Int
    private let tags: [String]
    private let version: String
    private let machineID: String?
    private let heartbeatIntervalMilliseconds: Int
    private let reconnectBaseDelayMilliseconds: Int
    private let reconnectMaxDelayMilliseconds: Int
    private let reconnectJitter: Bool
    private let maxReconnectAttempts: Int
    private let onError: (@Sendable (Error) -> Void)?
    private let makeTransport: @Sendable () -> NodeTransport

    private var capabilityOrder: [String] = []
    private var capabilityHandlers: [String: RegisteredCapability] = [:]
    private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]

    private var transport: NodeTransport?
    private var instanceID: String?
    private var registered = false
    private var stopped = true
    private var reconnectAttempt = 0
    private var heartbeatTask: Task<Void, Never>?
    private var serveTask: Task<Void, Error>?

    private var registrationState: RegistrationState = .pending
    private var registrationWaiters: [CheckedContinuation<NodeRegisterReplyData, Error>] = []

    public init(
        baseURL: String? = nil,
        nodeToken: String,
        nodeID: String,
        nodeName: String,
        provider: (name: String, instanceID: String?),
        capabilities: [String: NodeActionHandler] = [:],
        maxAgents: Int = 0,
        tags: [String] = [],
        version: String? = nil,
        machineID: String? = nil,
        heartbeatIntervalMilliseconds: Int = 15_000,
        reconnectBaseDelayMilliseconds: Int = 500,
        reconnectMaxDelayMilliseconds: Int = 30_000,
        reconnectJitter: Bool = true,
        maxReconnectAttempts: Int = Int.max,
        onError: (@Sendable (Error) -> Void)? = nil,
        session: URLSession = .shared,
        transport transportFactory: (@Sendable () -> NodeTransport)? = nil
    ) {
        let resolvedBaseURL = (baseURL ?? "https://cast.agentrelay.com")
        self.baseURL = resolvedBaseURL
        self.nodeToken = nodeToken
        self.nodeID = nodeID
        self.nodeName = nodeName
        self.providerName = provider.name
        self.initialInstanceID = provider.instanceID
        self.maxAgents = maxAgents
        self.tags = tags
        self.version = version ?? relaycastSDKVersion
        self.machineID = machineID
        self.heartbeatIntervalMilliseconds = max(1, heartbeatIntervalMilliseconds)
        self.reconnectBaseDelayMilliseconds = max(1, reconnectBaseDelayMilliseconds)
        self.reconnectMaxDelayMilliseconds = max(reconnectBaseDelayMilliseconds, reconnectMaxDelayMilliseconds)
        self.reconnectJitter = reconnectJitter
        self.maxReconnectAttempts = maxReconnectAttempts
        self.onError = onError

        if let transportFactory {
            self.makeTransport = transportFactory
        } else {
            let url = NodeProvider.webSocketURL(baseURL: resolvedBaseURL, token: nodeToken)
            self.makeTransport = { URLSessionNodeTransport(url: url, session: session) }
        }

        for (name, handler) in capabilities {
            capabilityOrder.append(name)
            capabilityHandlers[name] = RegisteredCapability(kind: nil, global: false, queue: false, metadata: nil, handler: handler)
        }
    }

    // MARK: Public API

    public var connected: Bool {
        registered && transport != nil
    }

    /// Register a capability and its handler.
    public func capability(
        _ name: String,
        kind: CapabilityKind? = nil,
        global: Bool = false,
        queue: Bool = false,
        metadata: [String: JSONValue]? = nil,
        handler: @escaping NodeActionHandler
    ) {
        if capabilityHandlers[name] == nil {
            capabilityOrder.append(name)
        }
        capabilityHandlers[name] = RegisteredCapability(kind: kind, global: global, queue: queue, metadata: metadata, handler: handler)
    }

    /// Resolves once the provider's first registration is accepted; throws if
    /// it is hard-rejected. Later reconnect registrations do not resettle this
    /// once the first attempt has settled.
    public func waitRegistered() async throws -> NodeRegisterReplyData {
        switch registrationState {
        case .resolved(let data):
            return data
        case .rejected(let error):
            throw error
        case .pending:
            return try await withCheckedThrowingContinuation { continuation in
                registrationWaiters.append(continuation)
            }
        }
    }

    /// Connect, register, and dispatch invokes until `stop()` is called.
    /// Reconnects with backoff on unexpected drops, re-registering with a
    /// fresh instance id. Resolves on graceful `stop()`; throws if the initial
    /// registration is rejected by the engine.
    public func serve() async throws {
        if let existing = serveTask {
            try await existing.value
            return
        }
        stopped = false
        reconnectAttempt = 0
        let task = Task<Void, Error> { [weak self] in
            try await self?.runServeLoop()
        }
        serveTask = task
        do {
            try await task.value
        } catch {
            serveTask = nil
            throw error
        }
        serveTask = nil
    }

    /// Gracefully deregister the provider and close the connection.
    public func stop() async {
        stopped = true
        if let transport {
            await sendDeregister(using: transport)
            await transport.close()
        }
        stopHeartbeat()
        rejectAllPending(NodeProviderError.stopped)
        serveTask?.cancel()
    }

    // MARK: Serve loop

    private func runServeLoop() async throws {
        var isFirstAttempt = true
        while !stopped {
            let outcome = await runConnectionAttempt(isFirstAttempt: isFirstAttempt)
            isFirstAttempt = false
            switch outcome {
            case .stoppedGracefully:
                return
            case .registrationRejected(let error):
                stopped = true
                reportError(error)
                throw error
            case .droppedUnexpectedly:
                if reconnectAttempt >= maxReconnectAttempts {
                    let error = NodeProviderError.reconnectAttemptsExhausted
                    stopped = true
                    reportError(error)
                    throw error
                }
                reconnectAttempt += 1
                let delayMs = computeBackoffDelayMilliseconds(attempt: reconnectAttempt)
                try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            }
        }
    }

    private func runConnectionAttempt(isFirstAttempt: Bool) async -> ConnectionOutcome {
        instanceID = isFirstAttempt ? (initialInstanceID ?? randomNodeProviderID()) : randomNodeProviderID()
        registered = false
        let newTransport = makeTransport()
        transport = newTransport

        let readLoop = Task { [weak self] in
            for await text in newTransport.incoming {
                await self?.handleFrame(text)
            }
            // The inbound stream finished (drop or close). Unblock any in-flight
            // request — including a register still awaiting its reply — so the
            // attempt can't hang waiting on a socket that is gone.
            await self?.rejectAllPending(NodeProviderError.connectionClosed)
        }

        do {
            let reply = try await sendRegister()
            registered = true
            reconnectAttempt = 0
            settleRegistration(.success(reply))
            startHeartbeat()

            await readLoop.value

            stopHeartbeat()
            registered = false
            transport = nil
            let wasStopped = stopped
            rejectAllPending(wasStopped ? NodeProviderError.stopped : NodeProviderError.connectionClosed)
            return wasStopped ? .stoppedGracefully : .droppedUnexpectedly
        } catch {
            readLoop.cancel()
            await newTransport.close()
            transport = nil
            registered = false
            if stopped {
                rejectAllPending(NodeProviderError.stopped)
                return .stoppedGracefully
            }
            rejectAllPending(error)
            // Only a protocol rejection (a rejected capability or an engine
            // `error` frame) is a hard failure. A transport failure during the
            // register handshake is a drop — reconnect rather than give up.
            if error is NodeRegistrationError {
                settleRegistration(.failure(error))
                return .registrationRejected(error)
            }
            return .droppedUnexpectedly
        }
    }

    private func computeBackoffDelayMilliseconds(attempt: Int) -> Int {
        let exponential = min(
            Double(reconnectBaseDelayMilliseconds) * pow(2, Double(attempt - 1)),
            Double(reconnectMaxDelayMilliseconds)
        )
        guard reconnectJitter else { return Int(exponential.rounded()) }
        return Int((exponential * Double.random(in: 0.5...1.5)).rounded())
    }

    // MARK: Registration

    private func settleRegistration(_ result: Result<NodeRegisterReplyData, Error>) {
        guard case .pending = registrationState else { return }
        switch result {
        case .success(let data):
            registrationState = .resolved(data)
        case .failure(let error):
            registrationState = .rejected(error)
        }
        let waiters = registrationWaiters
        registrationWaiters = []
        for waiter in waiters {
            switch result {
            case .success(let data): waiter.resume(returning: data)
            case .failure(let error): waiter.resume(throwing: error)
            }
        }
    }

    private func sendRegister() async throws -> NodeRegisterReplyData {
        let data = try await request(registerFrame())
        let reply = try NodeRegisterReplyData.parse(data)
        let rejected = reply.acceptedCapabilities.filter { !$0.accepted }
        guard rejected.isEmpty else {
            let detail = rejected
                .map { capability -> String in
                    guard let reason = capability.reason else { return capability.name }
                    return "\(capability.name) (\(reason))"
                }
                .joined(separator: ", ")
            throw NodeRegistrationError(code: "capabilities_rejected", message: "Capabilities rejected: \(detail)")
        }
        return reply
    }

    private func registerFrame() -> [String: JSONValue] {
        var fields: [String: JSONValue] = [
            "type": .string("node.register"),
            "name": .string(nodeName),
            "node_id": .string(nodeID),
            "provider": .object(["name": .string(providerName), "instance_id": .string(instanceID ?? "")]),
            "capabilities": capabilitiesFrameValue(),
            "max_agents": .int(maxAgents),
            "tags": .array(tags.map(JSONValue.string)),
            "version": .string(version),
            "resume_cursor": .null
        ]
        if let machineID { fields["machine_id"] = .string(machineID) }
        return fields
    }

    private func capabilitiesFrameValue() -> JSONValue {
        .array(capabilityOrder.compactMap { name -> JSONValue? in
            guard let cap = capabilityHandlers[name] else { return nil }
            var obj: [String: JSONValue] = ["name": .string(name)]
            if let kind = cap.kind { obj["kind"] = .string(kind.rawValue) }
            if cap.global { obj["global"] = .bool(true) }
            if cap.queue { obj["queue"] = .bool(true) }
            if let metadata = cap.metadata { obj["metadata"] = .object(metadata) }
            return .object(obj)
        })
    }

    // MARK: Heartbeat / deregister

    private func startHeartbeat() {
        stopHeartbeat()
        let intervalNanoseconds = UInt64(heartbeatIntervalMilliseconds) * 1_000_000
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: intervalNanoseconds)
                if Task.isCancelled { return }
                await self?.sendHeartbeat()
            }
        }
    }

    private func stopHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = nil
    }

    private func sendHeartbeat() async {
        guard let transport, registered, let instanceID else { return }
        let payload: [String: JSONValue] = [
            "v": .int(1),
            "type": .string("node.heartbeat"),
            "provider": .object(["name": .string(providerName), "instance_id": .string(instanceID)]),
            "load": .int(0),
            "active_agents": .int(0),
            "handlers_live": .bool(true)
        ]
        guard let text = try? encodeFrame(payload) else { return }
        try? await transport.send(text)
    }

    private func sendDeregister(using transport: NodeTransport) async {
        guard registered, let instanceID else { return }
        let payload: [String: JSONValue] = [
            "v": .int(1),
            "type": .string("node.deregister"),
            "provider": .object(["name": .string(providerName), "instance_id": .string(instanceID)])
        ]
        guard let text = try? encodeFrame(payload) else { return }
        try? await transport.send(text)
    }

    // MARK: Frame handling / dispatch

    private func handleFrame(_ text: String) {
        guard let frame = NodeProvider.parseFrame(text) else { return }
        switch frame {
        case .reply(let id, let data):
            resumePending(id: id, result: .success(data))
        case .error(let id, let code, let message):
            resumePending(id: id, result: .failure(NodeRegistrationError(code: code, message: message)))
        case .actionInvoke(let invocationID, let action, let input):
            Task { [weak self] in
                await self?.dispatchInvoke(invocationID: invocationID, action: action, input: input)
            }
        case .other:
            break
        }
    }

    private func dispatchInvoke(invocationID: String, action: String, input: JSONValue) async {
        guard let cap = capabilityHandlers[action] else {
            sendActionResult(invocationID: invocationID, error: "No handler registered for action \"\(action)\"")
            return
        }
        let ctx = makeContext(invocationID: invocationID)
        do {
            let output = try await cap.handler(input, ctx)
            sendActionResult(invocationID: invocationID, output: output)
        } catch {
            sendActionResult(invocationID: invocationID, error: errorMessage(error))
        }
    }

    private func sendActionResult(invocationID: String, output: JSONValue) {
        sendFrame(["type": .string("action.result"), "invocation_id": .string(invocationID), "output": output])
    }

    private func sendActionResult(invocationID: String, error: String) {
        sendFrame(["type": .string("action.result"), "invocation_id": .string(invocationID), "error": .string(error)])
    }

    private func sendFrame(_ fields: [String: JSONValue]) {
        guard let transport else { return }
        var payload = fields
        payload["v"] = .int(1)
        guard let text = try? encodeFrame(payload) else { return }
        Task { try? await transport.send(text) }
    }

    // MARK: Handler context

    private func makeContext(invocationID: String) -> NodeHandlerContext {
        NodeHandlerContext(
            node: .init(name: nodeName, capabilities: capabilityOrder),
            invocationID: invocationID,
            sendMessageImpl: { [weak self] to, from, text, mode, data in
                guard let self else { throw NodeProviderError.stopped }
                return try await self.sendMessageFrame(to: to, from: from, text: text, mode: mode, data: data)
            },
            spawnAgentImpl: { [weak self] input in
                guard let self else { throw NodeProviderError.stopped }
                return try await self.spawnAgentFrame(input)
            }
        )
    }

    private func sendMessageFrame(
        to: String,
        from: String,
        text: String,
        mode: NodeMessageMode?,
        data: [String: JSONValue]?
    ) async throws -> JSONValue {
        var payload: [String: JSONValue] = [
            "type": .string("node.message"),
            "to": .string(to),
            "from": .string(from),
            "text": .string(text)
        ]
        if let mode { payload["mode"] = .string(mode.rawValue) }
        if let data { payload["data"] = .object(data) }
        return try await request(payload)
    }

    private func spawnAgentFrame(_ input: [String: JSONValue]) async throws -> JSONValue {
        // Capacity-direct: the engine always targets this connection's own node,
        // so the frame carries no node target.
        try await request([
            "type": .string("node.spawn"),
            "input": .object(input)
        ])
    }

    // MARK: Request / reply

    private func request(_ fields: [String: JSONValue]) async throws -> JSONValue {
        guard let transport else { throw NodeProviderError.notConnected }
        let id = randomNodeProviderID()
        var payload = fields
        payload["id"] = .string(id)
        payload["v"] = .int(1)
        let text = try encodeFrame(payload)

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, Error>) in
            pending[id] = continuation
            Task { [weak self, transport] in
                do {
                    try await transport.send(text)
                } catch {
                    await self?.resumePending(id: id, result: .failure(error))
                }
            }
        }
    }

    private func resumePending(id: String, result: Result<JSONValue, Error>) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        switch result {
        case .success(let value): continuation.resume(returning: value)
        case .failure(let error): continuation.resume(throwing: error)
        }
    }

    private func rejectAllPending(_ error: Error) {
        let waiters = pending
        pending.removeAll()
        for (_, continuation) in waiters {
            continuation.resume(throwing: error)
        }
    }

    private func reportError(_ error: Error) {
        onError?(error)
    }

    // MARK: URL / encoding helpers

    private static func webSocketURL(baseURL: String, token: String) -> URL {
        let fallback = URL(string: "wss://cast.agentrelay.com/v1/node/ws")!
        let trimmed = baseURL
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")

        guard var components = URLComponents(string: "\(trimmed)/v1/node/ws") else {
            return fallback
        }
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "origin_client", value: RelaycastOrigin.client),
            URLQueryItem(name: "origin_version", value: RelaycastOrigin.version)
        ]
        return components.url ?? fallback
    }

    private enum InboundFrame {
        case reply(id: String, data: JSONValue)
        case error(id: String, code: String, message: String)
        case actionInvoke(invocationID: String, action: String, input: JSONValue)
        case other
    }

    private static func parseFrame(_ text: String) -> InboundFrame? {
        guard let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let obj) = value,
              case .string(let type)? = obj["type"]
        else {
            return nil
        }

        switch type {
        case "reply":
            guard case .string(let id)? = obj["id"] else { return nil }
            return .reply(id: id, data: obj["data"] ?? .null)
        case "error":
            guard case .string(let id)? = obj["id"],
                  case .string(let code)? = obj["code"],
                  case .string(let message)? = obj["message"]
            else { return nil }
            return .error(id: id, code: code, message: message)
        case "action.invoke":
            guard case .string(let invocationID)? = obj["invocation_id"],
                  case .string(let action)? = obj["action"]
            else { return nil }
            return .actionInvoke(invocationID: invocationID, action: action, input: obj["input"] ?? .object([:]))
        default:
            return .other
        }
    }
}

private func encodeFrame(_ fields: [String: JSONValue]) throws -> String {
    let data = try JSONEncoder().encode(fields)
    guard let text = String(data: data, encoding: .utf8) else {
        throw NodeProviderError.encodingFailed
    }
    return text
}

private func randomNodeProviderID() -> String {
    UUID().uuidString
}

private func errorMessage(_ error: Error) -> String {
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
        return description
    }
    return String(describing: error)
}
