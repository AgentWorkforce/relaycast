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

    func testNodesListSendsCapabilityFilterAndDecodesRoster() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/nodes")
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["capability"], "code")

            return jsonResponse([
                "ok": true,
                "data": [[
                    "id": "node_1",
                    "name": "alpha",
                    "kind": "ws",
                    "role": "broker",
                    "delivery_adapter": "ws.node.v1",
                    "delivery": NSNull(),
                    "capabilities": [["name": "code", "kind": "executor", "metadata": ["region": "us"]]],
                    "tags": ["primary"],
                    "version": "1.2.3",
                    "status": "online",
                    "live": true,
                    "handlers_live": true,
                    "load": 0.25,
                    "active_agents": 2,
                    "max_agents": 8,
                    "last_heartbeat_at": "2026-06-06T00:00:00Z",
                    "created_at": "2026-06-05T00:00:00Z"
                ]]
            ])
        }

        let nodes = try await relay.nodes.list(NodeListQuery(capability: "code"))
        XCTAssertEqual(nodes.count, 1)
        XCTAssertEqual(nodes[0].name, "alpha")
        XCTAssertEqual(nodes[0].capabilities.first?.name, "code")
        XCTAssertEqual(nodes[0].capabilities.first?.kind, "executor")
        XCTAssertEqual(nodes[0].activeAgents, 2)
        XCTAssertTrue(nodes[0].handlersLive)
        XCTAssertEqual(nodes[0].kind, "ws")
        XCTAssertEqual(nodes[0].role, "broker")
    }

    func testNodesCreateAndBindings() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/nodes"):
                let body = try XCTUnwrap(requestBodyData(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["name"] as? String, "http-node")
                XCTAssertEqual(json["kind"] as? String, "http_push")
                let delivery = try XCTUnwrap(json["delivery"] as? [String: Any])
                let auth = try XCTUnwrap(delivery["auth"] as? [String: Any])
                XCTAssertEqual(auth["signature_header"] as? String, "X-Custom-Signature")
                return jsonResponse([
                    "ok": true,
                    "data": [
                        "id": "node_1",
                        "name": "http-node",
                        "kind": "http_push",
                        "role": "direct",
                        "delivery_adapter": "http.hmac.v1",
                        "delivery": [
                            "url": "https://receiver.example.test/relaycast",
                            "ack_mode": "manual",
                            "auth": [
                                "type": "hmac_sha256",
                                "secret": "[redacted]",
                                "signature_header": "X-Custom-Signature"
                            ]
                        ],
                        "capabilities": [],
                        "tags": [],
                        "version": "unknown",
                        "status": "offline",
                        "live": false,
                        "handlers_live": false,
                        "load": 0,
                        "active_agents": 0,
                        "max_agents": 1,
                        "last_heartbeat_at": NSNull(),
                        "created_at": "2026-06-06T00:00:00Z",
                        "token": "nt_live_test"
                    ]
                ])
            case ("GET", "/v1/nodes/http-node/agents"):
                return jsonResponse([
                    "ok": true,
                    "data": [[
                        "id": "anb_1",
                        "agent_id": "agent_1",
                        "agent_name": "billing-agent",
                        "node_id": "node_1",
                        "node_name": "http-node",
                        "node_kind": "http_push",
                        "node_role": "direct",
                        "status": "active",
                        "session_ref": NSNull(),
                        "priority": 0,
                        "created_at": "2026-06-06T00:00:00Z",
                        "updated_at": NSNull()
                    ]]
                ])
            case ("POST", "/v1/nodes/http-node/agents"):
                let body = try XCTUnwrap(requestBodyData(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["agent_name"] as? String, "billing-agent")
                return jsonResponse([
                    "ok": true,
                    "data": [
                        "id": "anb_1",
                        "agent_id": "agent_1",
                        "agent_name": "billing-agent",
                        "node_id": "node_1",
                        "node_name": "http-node",
                        "node_kind": "http_push",
                        "node_role": "direct",
                        "status": "active",
                        "session_ref": NSNull(),
                        "priority": 5,
                        "created_at": "2026-06-06T00:00:00Z",
                        "updated_at": NSNull()
                    ]
                ])
            case ("DELETE", "/v1/nodes/http-node/agents/billing-agent"):
                return (
                    HTTPURLResponse(url: URL(string: "https://relay.test")!, statusCode: 204, httpVersion: nil, headerFields: nil)!,
                    Data()
                )
            default:
                return jsonResponse(["ok": false, "error": ["code": "not_found", "message": "Missing"]], status: 404)
            }
        }

        let created = try await relay.nodes.create(CreateNodeRequest(
            name: "http-node",
            kind: "http_push",
            delivery: .httpPush(HttpPushNodeDelivery(
                url: "https://receiver.example.test/relaycast",
                ackMode: "manual",
                auth: NodeDeliveryAuth(
                    type: "hmac_sha256",
                    secret: "secret",
                    signatureHeader: "X-Custom-Signature",
                    timestampHeader: "X-Custom-Timestamp",
                    signedPayload: "timestamp.body",
                    prefix: "sig="
                )
            ))
        ))
        XCTAssertEqual(created.token, "nt_live_test")
        XCTAssertEqual(created.deliveryAdapter, "http.hmac.v1")
        guard case .httpPush(let createdDelivery) = created.delivery else {
            return XCTFail("expected typed http_push delivery")
        }
        XCTAssertEqual(createdDelivery.url, "https://receiver.example.test/relaycast")
        XCTAssertEqual(createdDelivery.ackMode, "manual")
        XCTAssertEqual(createdDelivery.auth?.signatureHeader, "X-Custom-Signature")

        let bindings = try await relay.nodes.listAgents("http-node")
        XCTAssertEqual(bindings[0].agentName, "billing-agent")

        let binding = try await relay.nodes.bindAgent("http-node", request: BindAgentToNodeRequest(agentName: "billing-agent", priority: 5))
        XCTAssertEqual(binding.priority, 5)

        try await relay.nodes.unbindAgent("http-node", agentName: "billing-agent")
    }

    func testObserverTokensCreateListUpdateRotateAndRevoke() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/observer-tokens"):
                let body = try XCTUnwrap(requestBodyData(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["name"] as? String, "dashboard")
                XCTAssertEqual(json["scopes"] as? [String], ["stream:read", "messages:read"])
                let filters = try XCTUnwrap(json["filters"] as? [String: Any])
                XCTAssertEqual(filters["channel_names"] as? [String], ["general"])
                XCTAssertEqual(filters["include_dms"] as? Bool, false)
                return jsonResponse([
                    "ok": true,
                    "data": observerTokenData(token: "ot_live_secret")
                ], status: 201)
            case ("GET", "/v1/observer-tokens"):
                return jsonResponse([
                    "ok": true,
                    "data": [observerTokenData(token: NSNull())]
                ])
            case ("GET", "/v1/observer-tokens/ot_1"):
                return jsonResponse([
                    "ok": true,
                    "data": observerTokenData(token: NSNull())
                ])
            case ("PATCH", "/v1/observer-tokens/ot_1"):
                let body = try XCTUnwrap(requestBodyData(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["scopes"] as? [String], ["messages:read"])
                return jsonResponse([
                    "ok": true,
                    "data": observerTokenData(token: NSNull())
                ])
            case ("POST", "/v1/observer-tokens/ot_1/rotate"):
                return jsonResponse([
                    "ok": true,
                    "data": observerTokenData(token: "ot_live_rotated")
                ])
            case ("DELETE", "/v1/observer-tokens/ot_1"):
                return (
                    HTTPURLResponse(url: URL(string: "https://relay.test")!, statusCode: 204, httpVersion: nil, headerFields: nil)!,
                    Data()
                )
            default:
                return jsonResponse(["ok": false, "error": ["code": "not_found", "message": "Missing"]], status: 404)
            }
        }

        let created = try await relay.observerTokens.create(CreateObserverTokenRequest(
            name: "dashboard",
            scopes: ["stream:read", "messages:read"],
            filters: ObserverTokenFilters(channelNames: ["general"], includeDms: false)
        ))
        XCTAssertEqual(created.token, "ot_live_secret")
        XCTAssertEqual(created.filters.channelNames, ["general"])

        let listed = try await relay.observerTokens.list()
        XCTAssertEqual(listed[0].id, "ot_1")

        let fetched = try await relay.observerTokens.get("ot_1")
        XCTAssertEqual(fetched.name, "dashboard")

        let updated = try await relay.observerTokens.update("ot_1", data: UpdateObserverTokenRequest(scopes: ["messages:read"]))
        XCTAssertEqual(updated.scopes, ["stream:read", "messages:read"])

        let rotated = try await relay.observerTokens.rotate("ot_1")
        XCTAssertEqual(rotated.token, "ot_live_rotated")

        try await relay.observerTokens.revoke("ot_1")
    }

    func testCreateNodeRequestEncodesRawDeliveryConfig() throws {
        let request = CreateNodeRequest(
            name: "custom-node",
            kind: "custom",
            delivery: [
                "adapter": "custom.signature.v1",
                "signature": [
                    "header": "X-Custom-Signature",
                    "scheme": "ed25519"
                ]
            ]
        )

        let data = try makeRelaycastEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let delivery = try XCTUnwrap(json["delivery"] as? [String: Any])
        let signature = try XCTUnwrap(delivery["signature"] as? [String: Any])
        XCTAssertEqual(delivery["adapter"] as? String, "custom.signature.v1")
        XCTAssertEqual(signature["header"] as? String, "X-Custom-Signature")
    }

    func testTriggersCreateAndUpdate() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/triggers"):
                let body = try XCTUnwrap(requestBodyData(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["action_name"] as? String, "summarize")
                XCTAssertEqual(json["channel"] as? String, "general")
                return jsonResponse([
                    "ok": true,
                    "data": [
                        "id": "trg_1",
                        "channel": "general",
                        "pattern": NSNull(),
                        "mention": true,
                        "action_name": "summarize",
                        "enabled": true,
                        "last_triggered_at": NSNull(),
                        "created_at": "2026-06-06T00:00:00Z",
                        "updated_at": NSNull()
                    ]
                ])
            case ("PATCH", "/v1/triggers/trg_1"):
                let body = try XCTUnwrap(requestBodyData(request))
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertEqual(json["enabled"] as? Bool, false)
                return jsonResponse([
                    "ok": true,
                    "data": [
                        "id": "trg_1",
                        "channel": "general",
                        "pattern": NSNull(),
                        "mention": true,
                        "action_name": "summarize",
                        "enabled": false,
                        "last_triggered_at": NSNull(),
                        "created_at": "2026-06-06T00:00:00Z",
                        "updated_at": "2026-06-06T01:00:00Z"
                    ]
                ])
            default:
                return jsonResponse(["ok": false, "error": ["code": "not_found", "message": "Missing"]], status: 404)
            }
        }

        let created = try await relay.triggers.create(CreateTriggerRequest(actionName: "summarize", channel: "general", mention: true))
        XCTAssertEqual(created.id, "trg_1")
        XCTAssertTrue(created.enabled)

        let updated = try await relay.triggers.update("trg_1", data: UpdateTriggerRequest(enabled: false))
        XCTAssertFalse(updated.enabled)
        XCTAssertEqual(updated.updatedAt, "2026-06-06T01:00:00Z")
    }

    func testWorkspaceDMQueries() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            switch request.url?.path {
            case "/v1/dm/conversations/all":
                return jsonResponse([
                    "ok": true,
                    "data": [[
                        "id": "dm_1",
                        "channel_id": "ch_dm_1",
                        "type": "dm",
                        "participants": ["alice", "bob"],
                        "last_message": ["text": "hi", "agent_name": "alice", "created_at": "2026-06-06T00:00:00Z"],
                        "message_count": 3
                    ]]
                ])
            case "/v1/dm/conversations/dm_1/messages":
                let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
                let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
                XCTAssertEqual(query["limit"], "10")
                return jsonResponse([
                    "ok": true,
                    "data": [[
                        "id": "msg_dm_1",
                        "agent_id": "agent_1",
                        "agent_name": "alice",
                        "text": "hi",
                        "created_at": "2026-06-06T00:00:00Z"
                    ]]
                ])
            default:
                return jsonResponse(["ok": false, "error": ["code": "not_found", "message": "Missing"]], status: 404)
            }
        }

        let conversations = try await relay.allDMConversations()
        XCTAssertEqual(conversations.count, 1)
        XCTAssertEqual(conversations[0].participants, ["alice", "bob"])
        XCTAssertEqual(conversations[0].messageCount, 3)

        let messages = try await relay.dmMessages(conversationID: "dm_1", options: WorkspaceDMMessagesOptions(limit: 10))
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].agentName, "alice")
    }

    func testActivityFeed() async throws {
        let session = makeMockSession()
        let relay = try RelayCast(
            options: RelayCastOptions(apiKey: "rk_test", baseURL: "https://relay.test", retryPolicy: RetryPolicy(maxRetries: 0)),
            session: session
        )

        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/activity")
            let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
            let query = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            XCTAssertEqual(query["limit"], "5")
            return jsonResponse([
                "ok": true,
                "data": [[
                    "type": "message.created",
                    "id": "act_1",
                    "channel_name": "general",
                    "conversation_id": NSNull(),
                    "agent_name": "alice",
                    "text": "hello",
                    "created_at": "2026-06-06T00:00:00Z"
                ]]
            ])
        }

        let items = try await relay.activity(limit: 5)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].type, "message.created")
    }

    func testDeliveryStatusEnumUsesCurrentValues() throws {
        XCTAssertEqual(DeliveryStatus.queued.rawValue, "queued")
        XCTAssertEqual(DeliveryStatus.delivered.rawValue, "delivered")
        XCTAssertEqual(DeliveryStatus.acked.rawValue, "acked")
        XCTAssertEqual(DeliveryStatus.failed.rawValue, "failed")
        XCTAssertEqual(DeliveryStatus.deadLettered.rawValue, "dead_lettered")

        let decoded = try JSONDecoder().decode(DeliveryStatus.self, from: Data("\"dead_lettered\"".utf8))
        XCTAssertEqual(decoded, .deadLettered)
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

private func observerTokenData(token: Any) -> [String: Any] {
    [
        "id": "ot_1",
        "name": "dashboard",
        "description": NSNull(),
        "scopes": ["stream:read", "messages:read"],
        "filters": [
            "channel_names": ["general"],
            "include_dms": false
        ],
        "status": "active",
        "expires_at": NSNull(),
        "created_at": "2026-06-01T00:00:00Z",
        "updated_at": NSNull(),
        "revoked_at": NSNull(),
        "last_used_at": NSNull(),
        "token": token
    ]
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
