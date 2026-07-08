import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import Relaycast

/// A fake node-ws transport: captures frames the client sends and lets the
/// test drive replies/invokes without any real socket. Mirrors the engine's
/// request/reply-over-node-socket contract.
actor FakeNodeTransport: NodeTransport {
    nonisolated let incoming: AsyncStream<String>
    private let continuation: AsyncStream<String>.Continuation
    private var sentFrames: [[String: JSONValue]] = []
    private(set) var closed = false

    init() {
        let (stream, continuation) = AsyncStream<String>.makeStream(of: String.self)
        self.incoming = stream
        self.continuation = continuation
    }

    func send(_ text: String) async throws {
        guard let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let obj) = value
        else { return }
        sentFrames.append(obj)
    }

    func close() async {
        closed = true
        continuation.finish()
    }

    func sent() -> [[String: JSONValue]] {
        sentFrames
    }

    func sentOfType(_ type: String) -> [[String: JSONValue]] {
        sentFrames.filter {
            if case .string(let t)? = $0["type"] { return t == type }
            return false
        }
    }

    func lastRegister() -> [String: JSONValue]? {
        sentOfType("node.register").last
    }

    /// Push a frame to the client as if the engine sent it.
    func emit(_ frame: [String: JSONValue]) {
        guard let data = try? JSONEncoder().encode(frame), let text = String(data: data, encoding: .utf8) else { return }
        continuation.yield(text)
    }

    /// Simulate an unexpected drop (no `close()` from the client side).
    func drop() {
        continuation.finish()
    }
}

/// Creates a fresh `FakeNodeTransport` per connection attempt and keeps every
/// instance around so tests can inspect each connection epoch (mirrors the TS
/// suite's `MockWebSocket.instances`).
final class FakeTransportFactory: @unchecked Sendable {
    private let lock = NSLock()
    private var _instances: [FakeNodeTransport] = []

    func make() -> NodeTransport {
        let transport = FakeNodeTransport()
        lock.lock()
        _instances.append(transport)
        lock.unlock()
        return transport
    }

    var instances: [FakeNodeTransport] {
        lock.lock()
        defer { lock.unlock() }
        return _instances
    }
}

private func acceptAllReply(_ register: [String: JSONValue]) -> [String: JSONValue] {
    var capabilities: [JSONValue] = []
    if case .array(let items)? = register["capabilities"] {
        capabilities = items.map { item -> JSONValue in
            guard case .object(let obj) = item, case .string(let name)? = obj["name"] else { return item }
            let kind = obj["kind"] ?? .string("action")
            return .object(["name": .string(name), "kind": kind, "accepted": .bool(true)])
        }
    }
    return [
        "id": register["id"] ?? .null,
        "type": .string("reply"),
        "ok": .bool(true),
        "data": .object([
            "provider": register["provider"] ?? .object([:]),
            "accepted_capabilities": .array(capabilities),
            "name": register["name"] ?? .null
        ])
    ]
}

private func instanceID(_ register: [String: JSONValue]) -> String? {
    guard case .object(let provider)? = register["provider"], case .string(let id)? = provider["instance_id"] else {
        return nil
    }
    return id
}

@discardableResult
private func waitUntil(
    timeout: TimeInterval = 3.0,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: () async -> Bool
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("condition not met before timeout", file: file, line: line)
    return false
}

private let baseOptions: (nodeToken: String, nodeID: String, nodeName: String) = (
    nodeToken: "nt_live_test",
    nodeID: "node_a",
    nodeName: "alpha"
)

final class NodeProviderTests: XCTestCase {
    func testRegistersAndAcceptsCapabilities() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("run-etl") { input, _ in input }

        let serveTask = Task { try await node.serve() }

        await waitUntil { factory.instances.count == 1 }
        let transport = factory.instances[0]

        await waitUntil { await !transport.sentOfType("node.register").isEmpty }
        let register = await transport.lastRegister()!
        XCTAssertEqual(register["type"], .string("node.register"))
        XCTAssertEqual(register["name"], .string("alpha"))
        XCTAssertEqual(register["node_id"], .string("node_a"))
        XCTAssertEqual(register["capabilities"], .array([.object(["name": .string("run-etl")])]))
        guard case .object(let provider)? = register["provider"] else { return XCTFail("missing provider") }
        XCTAssertEqual(provider["name"], .string("py"))
        XCTAssertFalse(instanceID(register)?.isEmpty ?? true)

        await transport.emit(acceptAllReply(register))

        let reply = try await node.waitRegistered()
        XCTAssertEqual(reply.providerName, "py")
        let connected = await node.connected
        XCTAssertTrue(connected)

        await node.stop()
        try await serveTask.value
    }

    func testHardFailsRegistrationWhenCapabilityRejected() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("run-etl") { input, _ in input }

        let serveTask = Task { try await node.serve() }

        await waitUntil { factory.instances.count == 1 }
        let transport = factory.instances[0]
        await waitUntil { await !transport.sentOfType("node.register").isEmpty }
        let register = await transport.lastRegister()!

        await transport.emit([
            "id": register["id"] ?? .null,
            "type": .string("reply"),
            "ok": .bool(true),
            "data": .object([
                "provider": register["provider"] ?? .object([:]),
                "accepted_capabilities": .array([
                    .object(["name": .string("run-etl"), "kind": .string("action"), "accepted": .bool(false), "reason": .string("duplicate action name")])
                ])
            ])
        ])

        do {
            _ = try await node.waitRegistered()
            XCTFail("expected waitRegistered() to throw")
        } catch let error as NodeRegistrationError {
            XCTAssertEqual(error.code, "capabilities_rejected")
            XCTAssertTrue(error.message.contains("run-etl"))
            XCTAssertTrue(error.message.contains("duplicate action name"))
        }

        do {
            try await serveTask.value
            XCTFail("expected serve() to throw")
        } catch {
            // expected: serve() surfaces the same hard rejection.
        }
    }

    func testHardFailsRegistrationOnEngineErrorFrame() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )

        let serveTask = Task { try await node.serve() }

        await waitUntil { factory.instances.count == 1 }
        let transport = factory.instances[0]
        await waitUntil { await !transport.sentOfType("node.register").isEmpty }
        let register = await transport.lastRegister()!

        await transport.emit([
            "id": register["id"] ?? .null,
            "type": .string("error"),
            "ok": .bool(false),
            "code": .string("provider_instance_conflict"),
            "message": .string("already connected")
        ])

        do {
            _ = try await node.waitRegistered()
            XCTFail("expected waitRegistered() to throw")
        } catch let error as NodeRegistrationError {
            XCTAssertEqual(error.code, "provider_instance_conflict")
        }

        do {
            try await serveTask.value
            XCTFail("expected serve() to throw")
        } catch let error as NodeRegistrationError {
            XCTAssertEqual(error.code, "provider_instance_conflict")
        }
    }

    func testRunsHandlerOnInvokeAndRepliesWithOutput() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("run-etl") { input, _ in .object(["echoed": input]) }

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await transport.emit([
            "v": .int(1),
            "type": .string("action.invoke"),
            "invocation_id": .string("inv-1"),
            "action": .string("run-etl"),
            "input": .object(["rows": .int(3)])
        ])

        await waitUntil { await !transport.sentOfType("action.result").isEmpty }
        let result = await transport.sentOfType("action.result").last!
        XCTAssertEqual(result["invocation_id"], .string("inv-1"))
        XCTAssertEqual(result["output"], .object(["echoed": .object(["rows": .int(3)])]))
        XCTAssertNil(result["error"])

        await node.stop()
        try await serveTask.value
    }

    func testTurnsHandlerThrowIntoErrorResultAndNeverDropsTheInvocation() async throws {
        struct Boom: Error, LocalizedError {
            var errorDescription: String? { "boom" }
        }
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("run-etl") { _, _ in throw Boom() }

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await transport.emit([
            "v": .int(1),
            "type": .string("action.invoke"),
            "invocation_id": .string("inv-err"),
            "action": .string("run-etl"),
            "input": .object([:])
        ])

        await waitUntil { await !transport.sentOfType("action.result").isEmpty }
        let result = await transport.sentOfType("action.result").last!
        XCTAssertEqual(result["invocation_id"], .string("inv-err"))
        XCTAssertEqual(result["error"], .string("boom"))
        XCTAssertNil(result["output"])

        await node.stop()
        try await serveTask.value
    }

    func testErrorsAnInvokeForUnknownActionRatherThanDroppingIt() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("run-etl") { input, _ in input }

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await transport.emit([
            "v": .int(1),
            "type": .string("action.invoke"),
            "invocation_id": .string("inv-x"),
            "action": .string("nope"),
            "input": .object([:])
        ])

        await waitUntil { await !transport.sentOfType("action.result").isEmpty }
        let result = await transport.sentOfType("action.result").last!
        XCTAssertEqual(result["invocation_id"], .string("inv-x"))
        guard case .string(let message)? = result["error"] else { return XCTFail("expected an error message") }
        XCTAssertTrue(message.contains("nope"))

        await node.stop()
        try await serveTask.value
    }

    func testSendsProviderScopedHeartbeatsWhileServing() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            heartbeatIntervalMilliseconds: 30,
            transport: { factory.make() }
        )

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await waitUntil { await !transport.sentOfType("node.heartbeat").isEmpty }
        let heartbeat = await transport.sentOfType("node.heartbeat").last!
        guard case .object(let provider)? = heartbeat["provider"] else { return XCTFail("missing provider") }
        XCTAssertEqual(provider["name"], .string("py"))
        XCTAssertEqual(heartbeat["load"], .int(0))
        XCTAssertEqual(heartbeat["active_agents"], .int(0))
        XCTAssertEqual(heartbeat["handlers_live"], .bool(true))
        XCTAssertNil(heartbeat["last_heartbeat_at"])

        await node.stop()
        try await serveTask.value
    }

    func testReconnectsWithANewInstanceIDAfterAnUnexpectedDrop() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            reconnectBaseDelayMilliseconds: 20,
            reconnectMaxDelayMilliseconds: 100,
            reconnectJitter: false,
            transport: { factory.make() }
        )

        let serveTask = Task { try await node.serve() }
        let first = try await registerAndAccept(node: node, factory: factory)
        let firstRegister = await first.lastRegister()!
        let firstInstanceID = instanceID(firstRegister)

        await first.drop()

        await waitUntil { factory.instances.count == 2 }
        let second = factory.instances[1]
        await waitUntil { await !second.sentOfType("node.register").isEmpty }
        let secondRegister = await second.lastRegister()!
        XCTAssertEqual(secondRegister["name"], .string("alpha"))
        let secondInstanceID = instanceID(secondRegister)
        XCTAssertNotNil(secondInstanceID)
        XCTAssertNotEqual(secondInstanceID, firstInstanceID)

        await second.emit(acceptAllReply(secondRegister))
        await waitUntil { await node.connected }

        await node.stop()
        try await serveTask.value
    }

    func testDeregistersTheProviderOnGracefulStop() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await node.stop()
        try await serveTask.value

        let deregister = await transport.sentOfType("node.deregister").last
        XCTAssertNotNil(deregister)
        guard case .object(let provider)? = deregister?["provider"] else { return XCTFail("missing provider") }
        XCTAssertEqual(provider["name"], .string("py"))
    }

    func testSpawnAgentSendsACapacityDirectNodeSpawnFrameAndResolvesWithTheReply() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("spawn:claude") { _, ctx in
            try await ctx.spawnAgent(.object(["cli": .string("claude"), "name": .string("worker-1")]))
        }

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await transport.emit([
            "v": .int(1),
            "type": .string("action.invoke"),
            "invocation_id": .string("inv-spawn"),
            "action": .string("spawn:claude"),
            "input": .object([:])
        ])

        await waitUntil { await !transport.sentOfType("node.spawn").isEmpty }
        let spawn = await transport.sentOfType("node.spawn").last!
        XCTAssertEqual(spawn["input"], .object(["cli": .string("claude"), "name": .string("worker-1")]))
        XCTAssertEqual(spawn["target_node_id"], .string("node_a"))

        await transport.emit([
            "id": spawn["id"] ?? .null,
            "type": .string("reply"),
            "ok": .bool(true),
            "data": .object(["invocation_id": .string("spawned-1"), "status": .string("dispatched")])
        ])

        await waitUntil { await !transport.sentOfType("action.result").isEmpty }
        let result = await transport.sentOfType("action.result").last!
        XCTAssertEqual(result["output"], .object(["invocation_id": .string("spawned-1"), "status": .string("dispatched")]))

        await node.stop()
        try await serveTask.value
    }

    func testSendMessageSendsANodeMessageFrameAndResolvesWithTheReply() async throws {
        let factory = FakeTransportFactory()
        let node = NodeProvider(
            nodeToken: baseOptions.nodeToken,
            nodeID: baseOptions.nodeID,
            nodeName: baseOptions.nodeName,
            provider: (name: "py", instanceID: nil),
            transport: { factory.make() }
        )
        await node.capability("run-etl") { _, ctx in
            try await ctx.sendMessage(to: "ops", from: "reporter", text: "done")
        }

        let serveTask = Task { try await node.serve() }
        let transport = try await registerAndAccept(node: node, factory: factory)

        await transport.emit([
            "v": .int(1),
            "type": .string("action.invoke"),
            "invocation_id": .string("inv-msg"),
            "action": .string("run-etl"),
            "input": .object([:])
        ])

        await waitUntil { await !transport.sentOfType("node.message").isEmpty }
        let message = await transport.sentOfType("node.message").last!
        XCTAssertEqual(message["to"], .string("ops"))
        XCTAssertEqual(message["from"], .string("reporter"))
        XCTAssertEqual(message["text"], .string("done"))

        await transport.emit([
            "id": message["id"] ?? .null,
            "type": .string("reply"),
            "ok": .bool(true),
            "data": .object(["id": .string("m-1"), "text": .string("done")])
        ])

        await waitUntil { await !transport.sentOfType("action.result").isEmpty }
        let result = await transport.sentOfType("action.result").last!
        XCTAssertEqual(result["output"], .object(["id": .string("m-1"), "text": .string("done")]))

        await node.stop()
        try await serveTask.value
    }
}

/// Waits for the (first) transport to be created, sends `node.register`, and
/// accepts it, returning the transport once the provider is registered.
private func registerAndAccept(node: NodeProvider, factory: FakeTransportFactory) async throws -> FakeNodeTransport {
    await waitUntil { !factory.instances.isEmpty }
    let transport = factory.instances[factory.instances.count - 1]
    await waitUntil { await !transport.sentOfType("node.register").isEmpty }
    let register = await transport.lastRegister()!
    await transport.emit(acceptAllReply(register))
    _ = try await node.waitRegistered()
    return transport
}
