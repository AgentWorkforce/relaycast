import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import Relaycast

final class RelaycastTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

    func testHttpClientEncodesSnakeCaseAndOriginHeaders() async throws {
        let session = makeMockSession()
        let client = try HttpClient(
            options: ClientOptions(
                apiKey: "rk_test",
                baseURL: "https://relay.test",
                retryPolicy: RetryPolicy(maxRetries: 0),
                harness: "Codex/1.0",
                agentRelayDistinctID: "relay:abc"
            ),
            session: session
        )

        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/agents")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer rk_test")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-SDK-Version"), relaycastSDKVersion)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Relaycast-Origin-Client"), "@relaycast/sdk-swift")
            XCTAssertEqual(request.value(forHTTPHeaderField: relaycastHarnessHeader), "codex/1.0")
            XCTAssertEqual(request.value(forHTTPHeaderField: agentRelayDistinctIDHeader), "relay:abc")

            let body = try XCTUnwrap(requestBodyData(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["name"] as? String, "Worker")
            XCTAssertEqual(json["type"] as? String, "agent")

            return jsonResponse([
                "ok": true,
                "data": [
                    "id": "agent_1",
                    "name": "Worker",
                    "token": "at_test",
                    "status": "offline",
                    "created_at": "2026-06-06T00:00:00Z"
                ]
            ])
        }

        let created: CreateAgentResponse = try await client.post(
            "/v1/agents",
            body: CreateAgentRequest(name: "Worker", type: .agent)
        )

        XCTAssertEqual(created.createdAt, "2026-06-06T00:00:00Z")
    }

    func testHttpClientDecamelizesQueryAndIdempotencyHeaders() async throws {
        let session = makeMockSession()
        let client = try HttpClient(
            options: ClientOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["include_archived"], "true")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "idem-1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Idempotency-Key"), "idem-1")

            return jsonResponse([
                "ok": true,
                "data": []
            ])
        }

        let _: [Channel] = try await client.get(
            "/v1/channels",
            query: ["includeArchived": "true"],
            options: RequestOptions(idempotencyKey: "idem-1")
        )
    }

    func testHttpClientThrowsApiError() async throws {
        let session = makeMockSession()
        let client = try HttpClient(
            options: ClientOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { _ in
            jsonResponse([
                "ok": false,
                "error": [
                    "code": "not_found",
                    "message": "Missing"
                ]
            ], status: 404)
        }

        do {
            let _: Workspace = try await client.get("/v1/workspace")
            XCTFail("Expected RelayError")
        } catch let error as RelayError {
            XCTAssertEqual(error.code, "not_found")
            XCTAssertEqual(error.statusCode, 404)
            XCTAssertFalse(error.retryable)
        }
    }

    func testHttpClientRetriesRetryableStatuses() async throws {
        let session = makeMockSession()
        let client = try HttpClient(
            options: ClientOptions(
                apiKey: "rk_test",
                baseURL: "https://relay.test",
                retryPolicy: RetryPolicy(maxRetries: 1, backoffMilliseconds: 0, jitter: false)
            ),
            session: session
        )
        var attempts = 0

        MockURLProtocol.handler = { _ in
            attempts += 1
            if attempts == 1 {
                return jsonResponse([
                    "ok": false,
                    "error": [
                        "code": "server_error",
                        "message": "Try again"
                    ]
                ], status: 500)
            }
            return jsonResponse([
                "ok": true,
                "data": [
                    "id": "ws_1",
                    "name": "demo",
                    "system_prompt": NSNull(),
                    "plan": "free",
                    "created_at": "2026-06-06T00:00:00Z",
                    "metadata": [:]
                ]
            ])
        }

        let workspace: Workspace = try await client.get("/v1/workspace")
        XCTAssertEqual(workspace.name, "demo")
        XCTAssertEqual(attempts, 2)
    }

    func testRelayCastRegistersAgentAndResolvesIdentity() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/agents":
                return jsonResponse([
                    "ok": true,
                    "data": [
                        "id": "agent_1",
                        "name": "Worker",
                        "token": "at_test",
                        "status": "offline",
                        "created_at": "2026-06-06T00:00:00Z"
                    ]
                ])
            case "/v1/workspace":
                return jsonResponse([
                    "ok": true,
                    "data": [
                        "id": "ws_1",
                        "name": "demo",
                        "system_prompt": NSNull(),
                        "plan": "free",
                        "created_at": "2026-06-06T00:00:00Z",
                        "metadata": [:]
                    ]
                ])
            default:
                return jsonResponse(["ok": false, "error": ["code": "not_found", "message": "Missing"]], status: 404)
            }
        }

        let created = try await relay.agents.register(CreateAgentRequest(name: "Worker", type: .agent))
        let identity = try await relay.resolveIdentity()

        XCTAssertEqual(created.token, "at_test")
        XCTAssertEqual(identity.agentId, "agent_1")
        XCTAssertEqual(identity.workspaceId, "ws_1")
    }

    func testAgentClientSendStripsHashAndSendsIdempotencyKey() async throws {
        let session = makeMockSession()
        let http = try HttpClient(
            options: ClientOptions(apiKey: "at_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )
        let agent = try AgentClient(client: http)

        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/channels/general/messages")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), "msg-1")
            let body = try XCTUnwrap(requestBodyData(request))
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(json["text"] as? String, "hello")
            XCTAssertEqual(json["mode"] as? String, "wait")

            return jsonResponse([
                "ok": true,
                "data": [
                    "id": "msg_1",
                    "channel_id": "ch_1",
                    "agent_id": "agent_1",
                    "agent_name": "Worker",
                    "agent_type": "agent",
                    "text": "hello",
                    "blocks": NSNull(),
                    "metadata": [:],
                    "has_attachments": false,
                    "thread_id": NSNull(),
                    "attachments": [],
                    "created_at": "2026-06-06T00:00:00Z",
                    "reply_count": 0,
                    "reactions": [],
                    "read_by_count": 0
                ]
            ])
        }

        let message = try await agent.send("#general", text: "hello", options: SendMessageOptions(idempotencyKey: "msg-1"))
        XCTAssertEqual(message.id, "msg_1")
    }
}

private final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private func makeMockSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    return URLSession(configuration: configuration)
}

private func requestBodyData(_ request: URLRequest) -> Data? {
    if let body = request.httpBody {
        return body
    }
    guard let stream = request.httpBodyStream else {
        return nil
    }
    stream.open()
    defer { stream.close() }

    var data = Data()
    let bufferSize = 1_024
    let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
    defer { buffer.deallocate() }

    while stream.hasBytesAvailable {
        let read = stream.read(buffer, maxLength: bufferSize)
        if read < 0 {
            return nil
        }
        if read == 0 {
            break
        }
        data.append(buffer, count: read)
    }
    return data
}

private func jsonResponse(_ object: [String: Any], status: Int = 200) -> (HTTPURLResponse, Data) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    let response = HTTPURLResponse(
        url: URL(string: "https://relay.test")!,
        statusCode: status,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
    )!
    return (response, data)
}
