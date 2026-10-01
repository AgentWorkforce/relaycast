import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RelayCastWebSocketOptions: Equatable, Sendable {
    public var maxReconnectAttempts: Int
    public var reconnectBaseDelayMilliseconds: Int
    public var reconnectMaxDelayMilliseconds: Int
    public var reconnectJitter: Bool
    public var debug: Bool

    public init(
        maxReconnectAttempts: Int = 10,
        reconnectBaseDelayMilliseconds: Int = 1_000,
        reconnectMaxDelayMilliseconds: Int = 30_000,
        reconnectJitter: Bool = true,
        debug: Bool = false
    ) {
        self.maxReconnectAttempts = maxReconnectAttempts
        self.reconnectBaseDelayMilliseconds = reconnectBaseDelayMilliseconds
        self.reconnectMaxDelayMilliseconds = reconnectMaxDelayMilliseconds
        self.reconnectJitter = reconnectJitter
        self.debug = debug
    }
}

public struct RelayCastOptions: Equatable, Sendable {
    public var apiKey: String
    public var baseURL: String?
    public var retryPolicy: RetryPolicy
    public var ws: RelayCastWebSocketOptions
    public var harness: String?
    public var agentRelayDistinctID: String?

    public init(
        apiKey: String,
        baseURL: String? = nil,
        retryPolicy: RetryPolicy = RetryPolicy(),
        ws: RelayCastWebSocketOptions = RelayCastWebSocketOptions(),
        harness: String? = nil,
        agentRelayDistinctID: String? = nil
    ) {
        self.apiKey = apiKey
        self.baseURL = baseURL
        self.retryPolicy = retryPolicy
        self.ws = ws
        self.harness = harness
        self.agentRelayDistinctID = agentRelayDistinctID
    }
}

public struct WorkspaceBootstrapOptions: Equatable, Sendable {
    public var apiKey: String?
    public var baseURL: String?
    public var agentRelayDistinctID: String?

    public init(apiKey: String? = nil, baseURL: String? = nil, agentRelayDistinctID: String? = nil) {
        self.apiKey = apiKey
        self.baseURL = baseURL
        self.agentRelayDistinctID = agentRelayDistinctID
    }
}

public struct WorkspaceLookupOptions: Equatable, Sendable {
    public var baseURL: String?
    public var agentRelayDistinctID: String?

    public init(baseURL: String? = nil, agentRelayDistinctID: String? = nil) {
        self.baseURL = baseURL
        self.agentRelayDistinctID = agentRelayDistinctID
    }
}

public struct AgentReconnectOptions: Equatable, Sendable {
    public var apiToken: String
    public var agent: AgentClientOptions?

    public init(apiToken: String, agent: AgentClientOptions? = nil) {
        self.apiToken = apiToken
        self.agent = agent
    }
}

public final class RelayCast: @unchecked Sendable {
    public let client: HttpClient
    private let ws: WsClient
    private var identityHint: (agentID: String, name: String)?
    private var workspaceIDHint: String?

    public lazy var workspace = RelayWorkspaceService(relay: self)
    public lazy var observerTokens = RelayObserverTokensService(relay: self)
    public lazy var systemPrompt = RelaySystemPromptService(relay: self)
    public lazy var channels = RelayChannelsService(relay: self)
    public lazy var messages = RelayMessagesService(relay: self)
    public lazy var agents = RelayAgentsService(relay: self)
    public lazy var webhooks = RelayWebhooksService(relay: self)
    public lazy var subscriptions = RelaySubscriptionsService(relay: self)
    public lazy var actions = RelayActionsService(relay: self)
    public lazy var nodes = RelayNodesService(relay: self)
    public lazy var triggers = RelayTriggersService(relay: self)
    public lazy var certify = RelayCertifyService(relay: self)
    public lazy var console = RelayConsoleService(relay: self)

    public var on: RelaycastEventHandlers {
        ws.on
    }

    public init(options: RelayCastOptions, session: URLSession = .shared) throws {
        guard !options.apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw RelayError.invalidRequest("RelayCast apiKey is required")
        }

        self.client = try HttpClient(
            options: ClientOptions(
                apiKey: options.apiKey,
                baseURL: options.baseURL,
                retryPolicy: options.retryPolicy,
                harness: options.harness,
                agentRelayDistinctID: options.agentRelayDistinctID
            ),
            session: session
        )
        self.ws = WsClient(
            options: WsClientOptions(
                token: self.client.apiKey,
                baseURL: self.client.baseURL.absoluteString,
                maxReconnectAttempts: options.ws.maxReconnectAttempts,
                reconnectBaseDelayMilliseconds: options.ws.reconnectBaseDelayMilliseconds,
                reconnectMaxDelayMilliseconds: options.ws.reconnectMaxDelayMilliseconds,
                reconnectJitter: options.ws.reconnectJitter,
                debug: options.ws.debug,
                harness: self.client.harness,
                agentRelayDistinctID: self.client.agentRelayDistinctID,
                originSurface: self.client.originSurface,
                originClient: self.client.originClient,
                originVersion: self.client.originVersion
            ),
            session: session
        )
    }

    public func connect() {
        ws.connect()
    }

    public func disconnect() {
        ws.disconnect()
    }

    public static func createWorkspace(
        _ name: String,
        options: WorkspaceBootstrapOptions = WorkspaceBootstrapOptions()
    ) async throws -> CreateWorkspaceResponse {
        let (workspace, _) = try await workspaceRequest(
            method: "POST",
            path: "/v1/workspaces",
            body: CreateWorkspaceRequest(name: name),
            options: options
        ) as (CreateWorkspaceResponse, Int)
        return workspace
    }

    public static func lookupWorkspace(
        _ name: String,
        options: WorkspaceLookupOptions = WorkspaceLookupOptions()
    ) async throws -> WorkspaceLookup? {
        do {
            let bootstrap = WorkspaceBootstrapOptions(baseURL: options.baseURL, agentRelayDistinctID: options.agentRelayDistinctID)
            let (workspace, _) = try await workspaceRequest(
                method: "GET",
                path: "/v1/workspaces/by-name/\(percentEncodePathComponent(name))",
                body: Optional<EmptyRequest>.none,
                options: bootstrap
            ) as (WorkspaceLookup, Int)
            return workspace
        } catch let error as RelayError {
            if error.statusCode == 404 {
                return nil
            }
            throw error
        }
    }

    public static func ensureWorkspace(
        _ name: String,
        options: WorkspaceBootstrapOptions = WorkspaceBootstrapOptions()
    ) async throws -> EnsureWorkspaceResponse {
        let (workspace, status) = try await workspaceRequest(
            method: "POST",
            path: "/v1/workspaces",
            body: CreateWorkspaceRequest(name: name),
            options: options
        ) as (CreateWorkspaceResponse, Int)
        return EnsureWorkspaceResponse(
            workspaceId: workspace.workspaceId,
            apiKey: workspace.apiKey,
            createdAt: workspace.createdAt,
            existed: status == 200,
            name: name
        )
    }

    public func asAgent(_ apiToken: String, options: AgentClientOptions = AgentClientOptions()) throws -> AgentClient {
        try AgentClient(client: client.withApiKey(apiToken), options: options)
    }

    public func reconnect(_ data: AgentReconnectOptions, options: AgentClientOptions? = nil) async throws -> AgentClient {
        let agentClient = try asAgent(data.apiToken, options: data.agent ?? options ?? AgentClientOptions())
        let agent = try await agentClient.me()
        rememberIdentity(agentID: agent.id, name: agent.name)
        return agentClient
    }

    public func registerAgent(_ data: RegisterAgentRequest) async throws -> CreateAgentResponse {
        try await agents.register(data.createRequest)
    }

    public func registerOrRotate(_ data: RegisterAgentRequest) async throws -> CreateAgentResponse {
        try await agents.register(data.createRequest)
    }

    public func resolveIdentity() async throws -> ResolvedIdentity {
        guard let identityHint else {
            throw RelayError.api(code: "not_found", message: "No identity is available. Register or rotate an agent first.", statusCode: 404, retryable: false)
        }
        return ResolvedIdentity(agentId: identityHint.agentID, name: identityHint.name, workspaceId: try await resolveWorkspaceID())
    }

    public func agent(_ data: CreateAgentRequest) async throws -> CreateAgentResponse {
        var request = data
        request.type = .agent
        return try await agents.register(request)
    }

    public func human(_ data: CreateAgentRequest) async throws -> CreateAgentResponse {
        var request = data
        request.type = .human
        return try await agents.register(request)
    }

    public func system(_ data: CreateAgentRequest) async throws -> CreateAgentResponse {
        var request = data
        request.type = .system
        return try await agents.register(request)
    }

    public func registerA2A(_ options: RegisterA2AOptions) async throws -> RegisterA2AResponse {
        try await client.post("/v1/a2a/register", body: options)
    }

    public func listA2AAgents() async throws -> [A2AAgentRecord] {
        try await client.get("/v1/a2a/agents")
    }

    public func removeA2AAgent(name: String) async throws -> RemoveA2AAgentResponse {
        try await client.request("DELETE", path: "/v1/a2a/agents/\(percentEncodePathComponent(name))", body: Optional<EmptyRequest>.none)
    }

    public func getA2AAgentCard(name: String) async throws -> A2AAgentCard {
        try await client.get("/v1/a2a/agents/\(percentEncodePathComponent(name))/card")
    }

    public func route(skill: String, message: String? = nil) async throws -> RouteResult {
        try await client.post("/v1/route", body: RouteRequest(skill: skill, message: message))
    }

    public func searchDirectory(_ query: SearchDirectoryQuery = SearchDirectoryQuery()) async throws -> [DirectorySearchResult] {
        var params: [String: String] = [:]
        if let q = query.q { params["q"] = q }
        if let tags = query.tags, !tags.isEmpty { params["tags"] = tags.joined(separator: ",") }
        if let status = query.status { params["status"] = status }
        if let limit = query.limit { params["limit"] = String(limit) }
        return try await client.get("/v1/directory/search", query: params)
    }

    public func publishToDirectory(_ data: PublishToDirectoryRequest) async throws -> DirectoryAgent {
        try await client.post("/v1/directory/agents", body: data)
    }

    public func importSkills(_ data: ImportSkillsRequest) async throws -> DirectoryAgent? {
        try await client.post("/v1/skills/sync", body: data)
    }

    public func searchSkills(_ query: SkillSearchQuery = SkillSearchQuery()) async throws -> [SkillSearchResult] {
        var params: [String: String] = [:]
        if let q = query.q { params["q"] = q }
        if let limit = query.limit { params["limit"] = String(limit) }
        return try await client.get("/v1/skills/search", query: params)
    }

    public func routeFeedback(_ data: RouteFeedbackRequest) async throws -> RouteFeedbackResult {
        try await client.post("/v1/route/feedback", body: data)
    }

    public func listDirectory(_ query: ListDirectoryQuery = ListDirectoryQuery()) async throws -> [DirectoryAgent] {
        var params: [String: String] = [:]
        if let status = query.status { params["status"] = status }
        if let limit = query.limit { params["limit"] = String(limit) }
        return try await client.get("/v1/directory/agents", query: params)
    }

    public func getDirectoryAgent(slug: String) async throws -> DirectoryAgent {
        try await client.get("/v1/directory/agents/\(percentEncodePathComponent(slug))")
    }

    public func updateDirectoryAgent(slug: String, data: UpdateDirectoryAgentRequest) async throws -> DirectoryAgent {
        try await client.patch("/v1/directory/agents/\(percentEncodePathComponent(slug))", body: data)
    }

    public func deleteDirectoryAgent(slug: String) async throws {
        _ = try await client.delete("/v1/directory/agents/\(percentEncodePathComponent(slug))")
    }

    public func listDirectoryRatings(slug: String) async throws -> [DirectoryRating] {
        try await client.get("/v1/directory/agents/\(percentEncodePathComponent(slug))/ratings")
    }

    public func rateDirectoryAgent(slug: String, data: RateDirectoryAgentRequest) async throws -> DirectoryRating {
        try await client.post("/v1/directory/agents/\(percentEncodePathComponent(slug))/ratings", body: data)
    }

    public func getRoutingConfig() async throws -> RoutingConfig {
        try await client.get("/v1/routing/config")
    }

    public func updateRoutingConfig(_ data: UpdateRoutingConfigRequest) async throws -> RoutingConfig {
        try await client.put("/v1/routing/config", body: data)
    }

    public func activity(limit: Int? = nil) async throws -> [ActivityItem] {
        var params: [String: String] = [:]
        if let limit { params["limit"] = String(limit) }
        return try await client.get("/v1/activity", query: params)
    }

    public func allDMConversations() async throws -> [WorkspaceDMConversation] {
        try await client.get("/v1/dm/conversations/all")
    }

    public func dmMessages(conversationID: String, options: WorkspaceDMMessagesOptions = WorkspaceDMMessagesOptions()) async throws -> [WorkspaceDMMessage] {
        var params: [String: String] = [:]
        if let limit = options.limit { params["limit"] = String(limit) }
        if let before = options.before { params["before"] = before }
        if let after = options.after { params["after"] = after }
        return try await client.get("/v1/dm/conversations/\(percentEncodePathComponent(conversationID))/messages", query: params)
    }

    func rememberIdentity(agentID: String, name: String) {
        identityHint = (agentID, name)
    }

    private func resolveWorkspaceID() async throws -> String {
        if let workspaceIDHint {
            return workspaceIDHint
        }
        let workspace = try await workspace.info()
        workspaceIDHint = workspace.id
        return workspace.id
    }
}

public final class RelayWorkspaceService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func info() async throws -> Workspace {
        try await relay.client.get("/v1/workspace")
    }

    public func reconnect(_ data: AgentReconnectOptions, options: AgentClientOptions? = nil) async throws -> AgentClient {
        try await relay.reconnect(data, options: options)
    }

    public func update(_ data: UpdateWorkspaceRequest) async throws -> Workspace {
        try await relay.client.patch("/v1/workspace", body: data)
    }

    public func delete() async throws {
        _ = try await relay.client.delete("/v1/workspace")
    }
}

public final class RelayObserverTokensService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func create(_ data: CreateObserverTokenRequest) async throws -> ObserverToken {
        try await relay.client.post("/v1/observer-tokens", body: data)
    }

    public func list() async throws -> [ObserverToken] {
        try await relay.client.get("/v1/observer-tokens")
    }

    public func get(_ id: String) async throws -> ObserverToken {
        try await relay.client.get("/v1/observer-tokens/\(percentEncodePathComponent(id))")
    }

    public func update(_ id: String, data: UpdateObserverTokenRequest) async throws -> ObserverToken {
        try await relay.client.patch("/v1/observer-tokens/\(percentEncodePathComponent(id))", body: data)
    }

    public func rotate(_ id: String) async throws -> ObserverToken {
        try await relay.client.post("/v1/observer-tokens/\(percentEncodePathComponent(id))/rotate", body: EmptyRequest())
    }

    public func revoke(_ id: String) async throws {
        _ = try await relay.client.delete("/v1/observer-tokens/\(percentEncodePathComponent(id))")
    }
}

public final class RelaySystemPromptService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func get() async throws -> SystemPrompt {
        try await relay.client.get("/v1/workspace/system-prompt")
    }

    public func set(_ data: SetSystemPromptRequest) async throws -> SystemPrompt {
        try await relay.client.put("/v1/workspace/system-prompt", body: data)
    }
}

public final class RelayChannelsService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func list(_ options: ChannelListOptions = ChannelListOptions()) async throws -> [Channel] {
        var query: [String: String] = [:]
        if options.includeArchived { query["includeArchived"] = "true" }
        return try await relay.client.get("/v1/channels", query: query)
    }

    public func get(_ name: String) async throws -> ChannelWithMembers {
        try await relay.client.get("/v1/channels/\(percentEncodePathComponent(name))")
    }
}

public final class RelayMessagesService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func list(channel: String, options: MessageListQuery = MessageListQuery()) async throws -> [MessageWithMeta] {
        let name = stripHash(channel)
        return try await relay.client.get("/v1/channels/\(percentEncodePathComponent(name))/messages", query: options.queryItems)
    }

    public func get(_ id: String) async throws -> MessageWithMeta {
        try await relay.client.get("/v1/messages/\(percentEncodePathComponent(id))")
    }

    public func thread(_ id: String, options: MessageListQuery = MessageListQuery()) async throws -> ThreadResponse {
        try await relay.client.get("/v1/messages/\(percentEncodePathComponent(id))/replies", query: options.queryItems)
    }

    public func reactions(_ id: String) async throws -> [ReactionGroup] {
        try await relay.client.get("/v1/messages/\(percentEncodePathComponent(id))/reactions")
    }
}

public final class RelayAgentsService: @unchecked Sendable {
    private unowned let relay: RelayCast
    public lazy var events = RelayAgentEventsService(relay: relay)

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func register(_ data: CreateAgentRequest) async throws -> CreateAgentResponse {
        let created: CreateAgentResponse = try await relay.client.post("/v1/agents", body: data)
        relay.rememberIdentity(agentID: created.id, name: created.name)
        return created
    }

    public func list(_ query: AgentListQuery = AgentListQuery()) async throws -> [Agent] {
        var params: [String: String] = [:]
        if let status = query.status { params["status"] = status }
        return try await relay.client.get("/v1/agents", query: params)
    }

    public func get(_ name: String) async throws -> Agent {
        try await relay.client.get("/v1/agents/\(percentEncodePathComponent(name))")
    }

    public func me(apiToken: String? = nil) async throws -> Agent {
        let client = try apiToken.map { try relay.client.withApiKey($0) } ?? relay.client
        return try await client.get("/v1/agent")
    }

    public func rotateToken(_ name: String) async throws -> TokenRotateResponse {
        try await relay.client.post("/v1/agents/\(percentEncodePathComponent(name))/rotate-token", body: EmptyRequest())
    }

    public func recover(_ name: String, data: RecoverAgentRequest) async throws -> AgentIdentityRecoveryResponse {
        try await relay.client.post("/v1/agents/\(percentEncodePathComponent(name))/recover", body: data)
    }

    public func takeOver(_ name: String, data: TakeOverAgentRequest) async throws -> AgentIdentityRecoveryResponse {
        try await relay.client.post("/v1/agents/\(percentEncodePathComponent(name))/takeover", body: data)
    }

    public func revokeToken(_ name: String, data: RevokeAgentTokenRequest) async throws -> AgentIdentityRevocationResponse {
        try await relay.client.post("/v1/agents/\(percentEncodePathComponent(name))/revoke-token", body: data)
    }

    public func enrollRecoveryCredential(_ data: EnrollRecoveryCredentialRequest) async throws -> [String: JSONValue] {
        try await relay.client.post("/v1/agent/recovery-credential", body: data)
    }

    public func update(_ name: String, data: UpdateAgentRequest) async throws -> Agent {
        try await relay.client.patch("/v1/agents/\(percentEncodePathComponent(name))", body: data)
    }

    public func delete(_ name: String) async throws {
        _ = try await relay.client.delete("/v1/agents/\(percentEncodePathComponent(name))")
    }

    public func presence() async throws -> [AgentPresenceInfo] {
        try await relay.client.get("/v1/agents/presence")
    }

    public func registerAgent(_ data: RegisterAgentRequest) async throws -> CreateAgentResponse {
        try await relay.registerAgent(data)
    }

    public func registerOrRotate(_ data: RegisterAgentRequest) async throws -> CreateAgentResponse {
        try await relay.registerOrRotate(data)
    }

    public func resolveIdentity() async throws -> ResolvedIdentity {
        try await relay.resolveIdentity()
    }

    public func spawn(_ data: SpawnAgentRequest) async throws -> SpawnAgentResponse {
        try await relay.client.post("/v1/agents/spawn", body: data)
    }

    public func release(_ data: ReleaseAgentRequest) async throws -> ReleaseAgentResponse {
        try await relay.client.post("/v1/agents/release", body: data)
    }
}

public final class RelayAgentEventsService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func emit(agent name: String, data: EmitSessionEventRequest) async throws -> SessionEvent {
        try await relay.client.post("/v1/agents/\(percentEncodePathComponent(name))/events", body: data)
    }

    public func list(agent name: String, query: ListSessionEventsQuery = ListSessionEventsQuery()) async throws -> [SessionEvent] {
        var params: [String: String] = [:]
        if let type = query.type { params["type"] = type }
        if let limit = query.limit { params["limit"] = String(limit) }
        return try await relay.client.get("/v1/agents/\(percentEncodePathComponent(name))/events", query: params)
    }
}

public final class RelayWebhooksService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func create(_ data: CreateWebhookRequest) async throws -> CreateWebhookResponse {
        try await relay.client.post("/v1/webhooks", body: data)
    }

    public func createInbound(_ data: CreateWebhookRequest) async throws -> CreateWebhookResponse {
        try await create(data)
    }

    public func list() async throws -> [Webhook] {
        try await relay.client.get("/v1/webhooks")
    }

    public func delete(_ id: String) async throws {
        _ = try await relay.client.delete("/v1/webhooks/\(percentEncodePathComponent(id))")
    }

    public func trigger(webhookID: String, data: WebhookTriggerRequest, token: String) async throws -> WebhookTriggerResponse {
        let client = try relay.client.withApiKey(token)
        return try await client.post("/v1/hooks/\(percentEncodePathComponent(webhookID))", body: data)
    }
}

public final class RelaySubscriptionsService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func create(_ data: CreateSubscriptionRequest) async throws -> CreateSubscriptionResponse {
        try await relay.client.post("/v1/subscriptions", body: data)
    }

    public func list() async throws -> [EventSubscription] {
        try await relay.client.get("/v1/subscriptions")
    }

    public func get(_ id: String) async throws -> EventSubscription {
        try await relay.client.get("/v1/subscriptions/\(percentEncodePathComponent(id))")
    }

    public func delete(_ id: String) async throws {
        _ = try await relay.client.delete("/v1/subscriptions/\(percentEncodePathComponent(id))")
    }
}

public final class RelayActionsService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func register(_ data: RegisterActionRequest) async throws -> ActionDefinition {
        try await relay.client.post("/v1/actions", body: data)
    }

    public func list() async throws -> [ActionDefinition] {
        try await relay.client.get("/v1/actions")
    }

    public func get(_ name: String) async throws -> ActionDefinition {
        try await relay.client.get("/v1/actions/\(percentEncodePathComponent(name))")
    }

    public func delete(_ name: String) async throws {
        _ = try await relay.client.delete("/v1/actions/\(percentEncodePathComponent(name))")
    }
}

public final class RelayNodesService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func create(_ request: CreateNodeRequest) async throws -> CreateNodeResponse {
        try await relay.client.post("/v1/nodes", body: request)
    }

    public func list(_ query: NodeListQuery = NodeListQuery()) async throws -> [NodeRosterEntry] {
        var params: [String: String] = [:]
        if let capability = query.capability { params["capability"] = capability }
        if let name = query.name { params["name"] = name }
        return try await relay.client.get("/v1/nodes", query: params)
    }

    public func get(_ name: String) async throws -> NodeRosterEntry {
        try await relay.client.get("/v1/nodes/\(percentEncodePathComponent(name))")
    }

    public func listAgents(_ name: String) async throws -> [NodeAgentBinding] {
        try await relay.client.get("/v1/nodes/\(percentEncodePathComponent(name))/agents")
    }

    public func bindAgent(_ name: String, request: BindAgentToNodeRequest) async throws -> NodeAgentBinding {
        try await relay.client.post("/v1/nodes/\(percentEncodePathComponent(name))/agents", body: request)
    }

    public func unbindAgent(_ name: String, agentName: String) async throws {
        _ = try await relay.client.delete("/v1/nodes/\(percentEncodePathComponent(name))/agents/\(percentEncodePathComponent(agentName))")
    }
}

public final class RelayTriggersService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func create(_ data: CreateTriggerRequest) async throws -> Trigger {
        try await relay.client.post("/v1/triggers", body: data)
    }

    public func list() async throws -> [Trigger] {
        try await relay.client.get("/v1/triggers")
    }

    public func get(_ id: String) async throws -> Trigger {
        try await relay.client.get("/v1/triggers/\(percentEncodePathComponent(id))")
    }

    public func update(_ id: String, data: UpdateTriggerRequest) async throws -> Trigger {
        try await relay.client.patch("/v1/triggers/\(percentEncodePathComponent(id))", body: data)
    }

    public func delete(_ id: String) async throws {
        _ = try await relay.client.delete("/v1/triggers/\(percentEncodePathComponent(id))")
    }
}

public final class RelayCertifyService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func submit(_ data: SubmitCertificationRequest) async throws -> CertificationRun {
        try await relay.client.post("/v1/certify", body: data)
    }

    public func get(_ id: String) async throws -> CertificationRun {
        try await relay.client.get("/v1/certify/\(percentEncodePathComponent(id))")
    }

    public func badgeURL(_ id: String) -> URL? {
        URL(string: "/v1/certify/\(percentEncodePathComponent(id))/badge.svg", relativeTo: relay.client.baseURL)?.absoluteURL
    }

    public func monitor(_ data: MonitorCertificationRequest) async throws -> CertificationRun {
        try await relay.client.post("/v1/certify/monitor", body: data)
    }
}

public final class RelayConsoleService: @unchecked Sendable {
    private unowned let relay: RelayCast

    init(relay: RelayCast) {
        self.relay = relay
    }

    public func messages(_ query: ConsoleMessagesQuery = ConsoleMessagesQuery()) async throws -> [ConsoleMessageLog] {
        var params: [String: String] = [:]
        if let limit = query.limit { params["limit"] = String(limit) }
        if let before = query.before { params["before"] = before }
        if let agentID = query.agentId { params["agentId"] = agentID }
        if let channelID = query.channelId { params["channelId"] = channelID }
        if let conversationID = query.conversationId { params["conversationId"] = conversationID }
        if let deliveryKind = query.deliveryKind { params["deliveryKind"] = deliveryKind }
        return try await relay.client.get("/v1/console/messages", query: params)
    }

    public func stats(_ query: ConsoleWindowQuery = ConsoleWindowQuery()) async throws -> ConsoleOverview {
        var params: [String: String] = [:]
        if let days = query.days { params["days"] = String(days) }
        return try await relay.client.get("/v1/console/stats", query: params)
    }

    public func agentStats(_ query: ConsoleAgentStatsQuery = ConsoleAgentStatsQuery()) async throws -> [ConsoleAgentStat] {
        var params: [String: String] = [:]
        if let limit = query.limit { params["limit"] = String(limit) }
        return try await relay.client.get("/v1/console/agents", query: params)
    }

    public func costStats(_ query: ConsoleWindowQuery = ConsoleWindowQuery()) async throws -> ConsoleCostStats {
        var params: [String: String] = [:]
        if let days = query.days { params["days"] = String(days) }
        return try await relay.client.get("/v1/console/costs", query: params)
    }
}

private struct RouteRequest: Codable {
    var skill: String
    var message: String?
}

private extension RelayCast {
    static func workspaceRequest<T: Decodable, Body: Encodable>(
        method: String,
        path: String,
        body: Body?,
        options: WorkspaceBootstrapOptions
    ) async throws -> (T, Int) {
        let base = options.baseURL ?? "https://cast.agentrelay.com"
        guard let baseURL = URL(string: base),
              let url = URL(string: path.hasPrefix("/") ? String(path.dropFirst()) : path, relativeTo: baseURL.appendingPathComponent(""))?.absoluteURL
        else {
            throw RelayError.invalidRequest("Invalid Relaycast baseURL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(relaycastSDKVersion, forHTTPHeaderField: "X-SDK-Version")
        request.setValue(RelaycastOrigin.surface, forHTTPHeaderField: "X-Relaycast-Origin-Surface")
        request.setValue(RelaycastOrigin.client, forHTTPHeaderField: "X-Relaycast-Origin-Client")
        request.setValue(RelaycastOrigin.version, forHTTPHeaderField: "X-Relaycast-Origin-Version")
        if let apiKey = options.apiKey, !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        if let distinctID = sanitizeAgentRelayDistinctID(options.agentRelayDistinctID) {
            request.setValue(distinctID, forHTTPHeaderField: agentRelayDistinctIDHeader)
        }
        if let body, method.uppercased() != "GET" {
            request.httpBody = try makeRelaycastEncoder().encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RelayError.transport(message: "Relaycast response was not HTTP", statusCode: nil, retryable: true, cause: nil)
        }
        let envelope = try makeRelaycastDecoder().decode(ApiResponse<T>.self, from: data)
        guard envelope.ok else {
            throw relayErrorFromAPI(
                code: envelope.error?.code ?? "unknown_error",
                message: envelope.error?.message ?? "Unknown error",
                statusCode: http.statusCode
            )
        }
        guard let value = envelope.data else {
            throw RelayError.missingData("Relaycast API response was missing data")
        }
        return (value, http.statusCode)
    }
}
