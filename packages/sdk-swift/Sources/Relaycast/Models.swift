import Foundation

struct ApiResponse<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let cursor: Cursor?
    let error: ApiErrorInfo?
}

public struct ApiErrorInfo: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
}

public struct Cursor: Codable, Equatable, Sendable {
    public let next: String?
    public let hasMore: Bool
}

// MARK: - Workspace

public struct Workspace: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let systemPrompt: String?
    public let plan: String?
    public let createdAt: String
    public let metadata: [String: JSONValue]?
}

public struct CreateWorkspaceRequest: Codable, Equatable, Sendable {
    public var name: String

    public init(name: String) {
        self.name = name
    }
}

public struct CreateWorkspaceResponse: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let apiKey: String?
    public let createdAt: String
}

public struct WorkspaceLookup: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let createdAt: String
}

public struct EnsureWorkspaceResponse: Codable, Equatable, Sendable {
    public let workspaceId: String
    public let apiKey: String?
    public let createdAt: String
    public let existed: Bool
    public let name: String
}

public struct UpdateWorkspaceRequest: Codable, Equatable, Sendable {
    public var name: String?
    public var systemPrompt: String?

    public init(name: String? = nil, systemPrompt: String? = nil) {
        self.name = name
        self.systemPrompt = systemPrompt
    }
}

public struct SystemPrompt: Codable, Equatable, Sendable {
    public let prompt: String
    public let isDefault: Bool
}

public struct SetSystemPromptRequest: Codable, Equatable, Sendable {
    public var prompt: String?
    public var reset: Bool?

    public init(prompt: String? = nil, reset: Bool? = nil) {
        self.prompt = prompt
        self.reset = reset
    }
}

public struct WorkspaceStats: Codable, Equatable, Sendable {
    public let agents: JSONValue?
    public let messages: JSONValue?
    public let channels: JSONValue?
}

public struct ActivityItem: Codable, Equatable, Sendable {
    public let type: String
    public let id: String
    public let channelName: String?
    public let conversationId: String?
    public let agentName: String
    public let text: String
    public let createdAt: String
}

public struct WorkspaceDMLastMessage: Codable, Equatable, Sendable {
    public let text: String
    public let agentName: String
    public let createdAt: String
}

public struct WorkspaceDMConversation: Codable, Equatable, Sendable {
    public let id: String
    public let channelId: String?
    public let type: String
    public let participants: [String]
    public let lastMessage: WorkspaceDMLastMessage?
    public let messageCount: Int
}

public struct WorkspaceDMMessage: Codable, Equatable, Sendable {
    public let id: String
    public let agentId: String
    public let agentName: String
    public let text: String
    public let createdAt: String
}

public struct TokenRotateResponse: Codable, Equatable, Sendable {
    public let name: String
    public let token: String
}

// MARK: - Agents

public enum AgentType: String, Codable, Sendable {
    case agent
    case human
    case system
}

public enum AgentStatus: String, Codable, Sendable {
    case online
    case offline
    case away
}

public struct AgentSkillInput: Codable, Equatable, Sendable {
    public var id: String?
    public var name: String
    public var description: String?
    public var tags: [String]?
    public var metadata: [String: JSONValue]?

    public init(
        id: String? = nil,
        name: String,
        description: String? = nil,
        tags: [String]? = nil,
        metadata: [String: JSONValue]? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.tags = tags
        self.metadata = metadata
    }
}

public struct AgentChannelMembership: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let role: String
    public let joinedAt: String
}

public struct Agent: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let type: AgentType
    public let status: AgentStatus
    public let persona: String?
    public let metadata: [String: JSONValue]?
    public let lastSeen: String?
    public let createdAt: String?
    public let channels: [AgentChannelMembership]?
}

public struct CreateAgentRequest: Codable, Equatable, Sendable {
    public var name: String
    public var type: AgentType?
    public var persona: String?
    public var metadata: [String: JSONValue]?
    public var skills: [AgentSkillInput]?
    public var capabilities: [String: JSONValue]?

    public init(
        name: String,
        type: AgentType? = nil,
        persona: String? = nil,
        metadata: [String: JSONValue]? = nil,
        skills: [AgentSkillInput]? = nil,
        capabilities: [String: JSONValue]? = nil
    ) {
        self.name = name
        self.type = type
        self.persona = persona
        self.metadata = metadata
        self.skills = skills
        self.capabilities = capabilities
    }
}

public struct RegisterAgentRequest: Codable, Equatable, Sendable {
    public var name: String
    public var type: AgentType?
    public var persona: String?
    public var metadata: [String: JSONValue]?
    public var skills: [AgentSkillInput]?
    public var capabilities: [String: JSONValue]?
    public var strict: Bool?

    public init(
        name: String,
        type: AgentType? = nil,
        persona: String? = nil,
        metadata: [String: JSONValue]? = nil,
        skills: [AgentSkillInput]? = nil,
        capabilities: [String: JSONValue]? = nil,
        strict: Bool? = nil
    ) {
        self.name = name
        self.type = type
        self.persona = persona
        self.metadata = metadata
        self.skills = skills
        self.capabilities = capabilities
        self.strict = strict
    }

    var createRequest: CreateAgentRequest {
        CreateAgentRequest(name: name, type: type, persona: persona, metadata: metadata, skills: skills, capabilities: capabilities)
    }
}

public struct CreateAgentResponse: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let token: String
    public let status: AgentStatus
    public let createdAt: String
}

public struct UpdateAgentRequest: Codable, Equatable, Sendable {
    public var status: AgentStatus?
    public var persona: String?
    public var metadata: [String: JSONValue]?

    public init(status: AgentStatus? = nil, persona: String? = nil, metadata: [String: JSONValue]? = nil) {
        self.status = status
        self.persona = persona
        self.metadata = metadata
    }
}

public struct AgentListQuery: Equatable, Sendable {
    public var status: String?

    public init(status: String? = nil) {
        self.status = status
    }
}

public struct AgentPresenceInfo: Codable, Equatable, Sendable {
    public let agentId: String
    public let agentName: String
    public let status: String
}

public struct SpawnAgentRequest: Codable, Equatable, Sendable {
    public var name: String
    public var cli: String
    public var task: String
    public var channel: String?
    public var persona: String?
    public var metadata: [String: JSONValue]?

    public init(name: String, cli: String, task: String, channel: String? = nil, persona: String? = nil, metadata: [String: JSONValue]? = nil) {
        self.name = name
        self.cli = cli
        self.task = task
        self.channel = channel
        self.persona = persona
        self.metadata = metadata
    }
}

public struct SpawnAgentResponse: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let token: String
    public let cli: String
    public let task: String
    public let channel: String?
    public let status: AgentStatus
    public let createdAt: String
    public let alreadyExisted: Bool
}

public struct ReleaseAgentRequest: Codable, Equatable, Sendable {
    public var name: String
    public var reason: String?
    public var deleteAgent: Bool?

    public init(name: String, reason: String? = nil, deleteAgent: Bool? = nil) {
        self.name = name
        self.reason = reason
        self.deleteAgent = deleteAgent
    }
}

public struct ReleaseAgentResponse: Codable, Equatable, Sendable {
    public let name: String
    public let released: Bool
    public let deleted: Bool
    public let reason: String?
}

public struct ResolvedIdentity: Codable, Equatable, Sendable {
    public let agentId: String
    public let name: String
    public let workspaceId: String
}

// MARK: - Channels

public struct Channel: Codable, Equatable, Sendable {
    public let id: String
    public let workspaceId: String?
    public let name: String
    public let channelType: Int?
    public let topic: String?
    public let metadata: [String: JSONValue]?
    public let createdBy: String?
    public let createdAt: String
    public let isArchived: Bool?
    public let memberCount: Int?
}

public struct ChannelWithMembers: Codable, Equatable, Sendable {
    public let id: String
    public let workspaceId: String?
    public let name: String
    public let channelType: Int?
    public let topic: String?
    public let metadata: [String: JSONValue]?
    public let createdBy: String?
    public let createdAt: String
    public let isArchived: Bool?
    public let memberCount: Int?
    public let members: [ChannelMemberInfo]
}

public struct CreateChannelRequest: Codable, Equatable, Sendable {
    public var name: String
    public var topic: String?
    public var metadata: [String: JSONValue]?

    public init(name: String, topic: String? = nil, metadata: [String: JSONValue]? = nil) {
        self.name = name
        self.topic = topic
        self.metadata = metadata
    }
}

public struct UpdateChannelRequest: Codable, Equatable, Sendable {
    public var topic: String?
    public var metadata: [String: JSONValue]?

    public init(topic: String? = nil, metadata: [String: JSONValue]? = nil) {
        self.topic = topic
        self.metadata = metadata
    }
}

public struct ChannelMemberInfo: Codable, Equatable, Sendable {
    public let agentId: String
    public let agentName: String
    public let role: String
    public let joinedAt: String
}

public struct JoinChannelResponse: Codable, Equatable, Sendable {
    public let channel: String?
    public let joined: Bool?
}

public struct InviteChannelResponse: Codable, Equatable, Sendable {
    public let channel: String?
    public let agent: String?
    public let invited: Bool?
}

public struct ChannelListOptions: Equatable, Sendable {
    public var includeArchived: Bool

    public init(includeArchived: Bool = false) {
        self.includeArchived = includeArchived
    }
}

// MARK: - Messages

public enum MessageInjectionMode: String, Codable, Sendable {
    case wait
    case steer
}

public struct MessageBlock: Codable, Equatable, Sendable {
    public var type: String
    public var data: [String: JSONValue]

    public init(type: String, data: [String: JSONValue] = [:]) {
        self.type = type
        self.data = data
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.type = try container.decode(String.self, forKey: DynamicCodingKey("type"))
        var data: [String: JSONValue] = [:]
        for key in container.allKeys where key.stringValue != "type" {
            data[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
        }
        self.data = data
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        try container.encode(type, forKey: DynamicCodingKey("type"))
        for (key, value) in data {
            try container.encode(value, forKey: DynamicCodingKey(key))
        }
    }
}

struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = "\(intValue)"
        self.intValue = intValue
    }
}

public struct FileAttachment: Codable, Equatable, Sendable {
    public let fileId: String
    public let filename: String
    public let contentType: String
    public let sizeBytes: Int?
}

public struct ReactionGroup: Codable, Equatable, Sendable {
    public let emoji: String
    public let count: Int
    public let agents: [String]
}

public struct CoreMessagePayload: Codable, Equatable, Sendable {
    public let id: String
    public let agentId: String
    public let agentName: String
    public let agentType: AgentType?
    public let text: String
    public let injectionMode: MessageInjectionMode?
    public let attachments: [FileAttachment]?
}

public struct MessageWithMeta: Codable, Equatable, Sendable {
    public let id: String
    public let channelId: String?
    public let agentId: String
    public let agentName: String
    public let agentType: AgentType?
    public let text: String
    public let blocks: [MessageBlock]?
    public let metadata: [String: JSONValue]?
    public let hasAttachments: Bool?
    public let threadId: String?
    public let attachments: [FileAttachment]?
    public let createdAt: String
    public let replyCount: Int?
    public let reactions: [ReactionGroup]?
    public let readByCount: Int?
    public let mentions: [String]?
    public let injectionMode: MessageInjectionMode?
}

public struct PostMessageRequest: Codable, Equatable, Sendable {
    public var text: String
    public var blocks: [MessageBlock]?
    public var attachments: [String]?
    public var data: [String: JSONValue]?
    public var contentType: String?
    public var mode: MessageInjectionMode?

    public init(
        text: String,
        blocks: [MessageBlock]? = nil,
        attachments: [String]? = nil,
        data: [String: JSONValue]? = nil,
        contentType: String? = nil,
        mode: MessageInjectionMode? = .wait
    ) {
        self.text = text
        self.blocks = blocks
        self.attachments = attachments
        self.data = data
        self.contentType = contentType
        self.mode = mode
    }
}

public struct ThreadReplyRequest: Codable, Equatable, Sendable {
    public var text: String
    public var blocks: [MessageBlock]?
    public var data: [String: JSONValue]?

    public init(text: String, blocks: [MessageBlock]? = nil, data: [String: JSONValue]? = nil) {
        self.text = text
        self.blocks = blocks
        self.data = data
    }
}

public struct MessageListQuery: Equatable, Sendable {
    public var limit: Int?
    public var before: String?
    public var after: String?

    public init(limit: Int? = nil, before: String? = nil, after: String? = nil) {
        self.limit = limit
        self.before = before
        self.after = after
    }

    var queryItems: [String: String] {
        var query: [String: String] = [:]
        if let limit { query["limit"] = String(limit) }
        if let before { query["before"] = before }
        if let after { query["after"] = after }
        return query
    }
}

public struct ThreadResponse: Codable, Equatable, Sendable {
    public let parent: MessageWithMeta
    public let replies: [MessageWithMeta]
}

public struct SearchMessageResult: Codable, Equatable, Sendable {
    public let id: String
    public let channelName: String
    public let agentName: String
    public let text: String
    public let createdAt: String
    public let relevanceScore: Double
}

// MARK: - DMs

public struct SendDMRequest: Codable, Equatable, Sendable {
    public var to: String
    public var text: String
    public var attachments: [String]?
    public var mode: MessageInjectionMode?

    public init(to: String, text: String, attachments: [String]? = nil, mode: MessageInjectionMode? = .wait) {
        self.to = to
        self.text = text
        self.attachments = attachments
        self.mode = mode
    }
}

public struct SendDMResponse: Codable, Equatable, Sendable {
    public let conversationId: String
    public let message: CoreMessagePayload
    public let createdAt: String
}

public struct CreateGroupDMRequest: Codable, Equatable, Sendable {
    public var participants: [String]
    public var name: String?

    public init(participants: [String], name: String? = nil) {
        self.participants = participants
        self.name = name
    }
}

public struct DMConversationParticipant: Codable, Equatable, Sendable {
    public let agentId: String
    public let agentName: String
}

public struct DMLastMessage: Codable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let agentId: String
    public let agentType: AgentType?
    public let createdAt: String
}

public struct DMConversationSummary: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let name: String?
    public let participants: [DMConversationParticipant]
    public let lastMessage: DMLastMessage?
    public let unreadCount: Int
    public let createdAt: String
}

public struct CreateGroupDMResponse: Codable, Equatable, Sendable {
    public let id: String
    public let channelId: String
    public let dmType: String
    public let name: String?
    public let participants: [GroupDMParticipantRef]
    public let createdAt: String
}

public struct GroupDMParticipantRef: Codable, Equatable, Sendable {
    public let agentId: String
}

public struct GroupDMMessageResponse: Codable, Equatable, Sendable {
    public let conversationId: String
    public let message: CoreMessagePayload
    public let createdAt: String
}

public struct GroupDMParticipantResponse: Codable, Equatable, Sendable {
    public let conversationId: String
    public let agent: String
    public let alreadyMember: Bool
}

public struct DMMessage: Codable, Equatable, Sendable {
    public let id: String
    public let agentId: String
    public let agentName: String
    public let agentType: AgentType?
    public let text: String
    public let injectionMode: MessageInjectionMode?
    public let attachments: [FileAttachment]?
    public let createdAt: String
}

public struct DMOptions: Equatable, Sendable {
    public var mode: MessageInjectionMode
    public var attachments: [String]?
    public var idempotencyKey: String?

    public init(mode: MessageInjectionMode = .wait, attachments: [String]? = nil, idempotencyKey: String? = nil) {
        self.mode = mode
        self.attachments = attachments
        self.idempotencyKey = idempotencyKey
    }
}

// MARK: - Reactions, search, inbox, receipts

public struct AddedReaction: Codable, Equatable, Sendable {
    public let emoji: String
    public let messageId: String?
    public let agentName: String?
}

public struct SearchOptions: Equatable, Sendable {
    public var channel: String?
    public var from: String?
    public var limit: Int?
    public var before: String?
    public var after: String?

    public init(channel: String? = nil, from: String? = nil, limit: Int? = nil, before: String? = nil, after: String? = nil) {
        self.channel = channel
        self.from = from
        self.limit = limit
        self.before = before
        self.after = after
    }
}

public struct UnreadChannel: Codable, Equatable, Sendable {
    public let channelName: String
    public let unreadCount: Int
}

public struct InboxMention: Codable, Equatable, Sendable {
    public let id: String
    public let channelName: String
    public let agentName: String
    public let text: String
    public let createdAt: String
}

public struct UnreadDM: Codable, Equatable, Sendable {
    public let conversationId: String
    public let from: String
    public let unreadCount: Int
    public let lastMessage: String?
}

public struct InboxResponse: Codable, Equatable, Sendable {
    public let unreadChannels: [UnreadChannel]
    public let mentions: [InboxMention]
    public let unreadDms: [UnreadDM]
}

public struct ReadReceipt: Codable, Equatable, Sendable {
    public let messageId: String?
    public let agentId: String?
    public let readAt: String?
}

public struct ReaderInfo: Codable, Equatable, Sendable {
    public let agentName: String
    public let agentId: String
    public let readAt: String
}

public struct ChannelReadStatus: Codable, Equatable, Sendable {
    public let agentName: String
    public let lastReadId: String?
    public let lastReadAt: String?
}

// MARK: - Deliveries

public enum DeliveryStatus: String, Codable, Sendable {
    case queued
    case delivered
    case acked
    case failed
    case deadLettered = "dead_lettered"
}

public struct DeliveryMessage: Codable, Equatable, Sendable {
    public let id: String
    public let channelId: String
    public let agentId: String?
    public let agentName: String?
    public let text: String
    public let threadId: String?
    public let createdAt: String
}

public struct Delivery: Codable, Equatable, Sendable {
    public let id: String
    public let messageId: String
    public let channelId: String
    public let agentId: String
    public let status: DeliveryStatus
    public let seq: Int?
    public let locationType: String?
    public let locationNodeId: String?
    public let routeNodeId: String?
    public let routeNodeKind: String?
    public let deliveryAdapter: String?
    public let dispatchAttempts: Int?
    public let nextAttemptAt: String?
    public let lastDispatchError: String?
    public let mode: String
    public let reason: String?
    public let priority: String?
    public let retryable: Bool?
    public let error: String?
    public let availableAt: String?
    public let deadline: String?
    public let expiresAt: String?
    public let deliveredAt: String?
    public let ackedAt: String?
    public let deadLetteredAt: String?
    public let createdAt: String
    public let updatedAt: String?
}

public struct DeliveryItem: Codable, Equatable, Sendable {
    public let id: String
    public let messageId: String
    public let channelId: String
    public let agentId: String
    public let status: DeliveryStatus
    public let seq: Int?
    public let locationType: String?
    public let locationNodeId: String?
    public let routeNodeId: String?
    public let routeNodeKind: String?
    public let deliveryAdapter: String?
    public let dispatchAttempts: Int?
    public let nextAttemptAt: String?
    public let lastDispatchError: String?
    public let mode: String
    public let reason: String?
    public let priority: String?
    public let retryable: Bool?
    public let error: String?
    public let availableAt: String?
    public let deadline: String?
    public let expiresAt: String?
    public let deliveredAt: String?
    public let ackedAt: String?
    public let deadLetteredAt: String?
    public let createdAt: String
    public let updatedAt: String?
    public let message: DeliveryMessage?
}

public struct ListDeliveriesOptions: Equatable, Sendable {
    public var status: DeliveryStatus?
    public var limit: Int?

    public init(status: DeliveryStatus? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public struct FailDeliveryRequest: Codable, Equatable, Sendable {
    public var error: String?
    public var retryable: Bool?

    public init(error: String? = nil, retryable: Bool? = nil) {
        self.error = error
        self.retryable = retryable
    }
}

public struct DeferDeliveryRequest: Codable, Equatable, Sendable {
    public var availableAt: String
    public var reason: String?

    public init(availableAt: String, reason: String? = nil) {
        self.availableAt = availableAt
        self.reason = reason
    }
}

// MARK: - Files

public struct UploadRequest: Codable, Equatable, Sendable {
    public var filename: String
    public var contentType: String
    public var sizeBytes: Int

    public init(filename: String, contentType: String, sizeBytes: Int) {
        self.filename = filename
        self.contentType = contentType
        self.sizeBytes = sizeBytes
    }
}

public struct UploadResponse: Codable, Equatable, Sendable {
    public let fileId: String
    public let uploadUrl: String
    public let expiresAt: String
}

public struct CompleteUploadResponse: Codable, Equatable, Sendable {
    public let fileId: String?
    public let status: String?
}

public struct FileInfo: Codable, Equatable, Sendable {
    public let fileId: String
    public let filename: String
    public let contentType: String
    public let size: Int?
    public let url: String?
    public let uploadedBy: String?
    public let createdAt: String?
}

public struct FileListOptions: Equatable, Sendable {
    public var uploadedBy: String?
    public var limit: Int?

    public init(uploadedBy: String? = nil, limit: Int? = nil) {
        self.uploadedBy = uploadedBy
        self.limit = limit
    }
}

// MARK: - Webhooks, subscriptions, actions

public struct CreateWebhookRequest: Codable, Equatable, Sendable {
    public var name: String?
    public var channel: String

    public init(channel: String, name: String? = nil) {
        self.name = name
        self.channel = channel
    }
}

public struct CreateWebhookResponse: Codable, Equatable, Sendable {
    public let webhookId: String
    public let name: String
    public let channel: String
    public let url: String
    public let token: String
    public let isActive: Bool
    public let createdAt: String
}

public struct Webhook: Codable, Equatable, Sendable {
    public let id: String
    public let workspaceId: String?
    public let name: String
    public let channelId: String?
    public let channelName: String?
    public let url: String
    public let createdBy: String?
    public let createdAt: String
    public let isActive: Bool
}

public struct WebhookTriggerRequest: Codable, Equatable, Sendable {
    public var text: String?
    public var message: String?
    public var blocks: [MessageBlock]?
    public var source: String?
    public var author: String?
    public var payload: [String: JSONValue]?

    public init(text: String? = nil, message: String? = nil, blocks: [MessageBlock]? = nil, source: String? = nil, author: String? = nil, payload: [String: JSONValue]? = nil) {
        self.text = text
        self.message = message
        self.blocks = blocks
        self.source = source
        self.author = author
        self.payload = payload
    }
}

public struct WebhookTriggerResponse: Codable, Equatable, Sendable {
    public let id: String?
    public let message: MessageWithMeta?
    public let accepted: Bool?
}

public struct CreateSubscriptionRequest: Codable, Equatable, Sendable {
    public var url: String
    public var events: [String]
    public var secret: String?

    public init(url: String, events: [String], secret: String? = nil) {
        self.url = url
        self.events = events
        self.secret = secret
    }
}

public struct CreateSubscriptionResponse: Codable, Equatable, Sendable {
    public let id: String
    public let url: String
    public let events: [String]
    public let createdAt: String?
}

public struct EventSubscription: Codable, Equatable, Sendable {
    public let id: String
    public let url: String
    public let events: [String]
    public let isActive: Bool?
    public let createdAt: String?
}

public struct RegisterActionRequest: Codable, Equatable, Sendable {
    public var name: String
    public var description: String
    public var handlerAgent: String
    public var inputSchema: [String: JSONValue]?
    public var outputSchema: [String: JSONValue]?
    public var availableTo: [String]?

    public init(
        name: String,
        description: String,
        handlerAgent: String,
        inputSchema: [String: JSONValue]? = nil,
        outputSchema: [String: JSONValue]? = nil,
        availableTo: [String]? = nil
    ) {
        self.name = name
        self.description = description
        self.handlerAgent = handlerAgent
        self.inputSchema = inputSchema
        self.outputSchema = outputSchema
        self.availableTo = availableTo
    }
}

public struct ActionDefinition: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let description: String
    public let handlerAgent: String
    public let inputSchema: [String: JSONValue]?
    public let outputSchema: [String: JSONValue]?
    public let availableTo: [String]?
    public let isActive: Bool?
    public let createdAt: String?
}

public struct InvokeActionResult: Codable, Equatable, Sendable {
    public let invocationId: String
    public let actionName: String
    public let handlerAgentId: String?
    public let input: [String: JSONValue]?
    public let status: String
    public let createdAt: String?
}

public struct CompleteInvocationRequest: Codable, Equatable, Sendable {
    public var output: [String: JSONValue]?
    public var error: String?

    public init(output: [String: JSONValue]? = nil, error: String? = nil) {
        self.output = output
        self.error = error
    }
}

public struct ActionInvocation: Codable, Equatable, Sendable {
    public let id: String
    public let actionName: String?
    public let status: String
    public let input: [String: JSONValue]?
    public let output: [String: JSONValue]?
    public let error: String?
    public let createdAt: String?
    public let updatedAt: String?
}

// MARK: - Directory, routing, A2A, certification, console

public struct RouteResult: Codable, Equatable, Sendable {
    public let agentName: String
    public let score: Double
    public let fallback: Bool
}

public struct SearchDirectoryQuery: Equatable, Sendable {
    public var q: String?
    public var tags: [String]?
    public var status: String?
    public var limit: Int?

    public init(q: String? = nil, tags: [String]? = nil, status: String? = nil, limit: Int? = nil) {
        self.q = q
        self.tags = tags
        self.status = status
        self.limit = limit
    }
}

public struct DirectorySkillInput: Codable, Equatable, Sendable {
    public var id: String?
    public var name: String
    public var description: String?
    public var tags: [String]?
    public var metadata: [String: JSONValue]?

    public init(id: String? = nil, name: String, description: String? = nil, tags: [String]? = nil, metadata: [String: JSONValue]? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.tags = tags
        self.metadata = metadata
    }
}

public struct DirectorySkill: Codable, Equatable, Sendable {
    public let id: String
    public let skillId: String?
    public let name: String
    public let description: String?
    public let tags: [String]?
    public let metadata: [String: JSONValue]?
}

public struct DirectoryAgent: Codable, Equatable, Sendable {
    public let id: String
    public let sourceAgentId: String?
    public let slug: String
    public let name: String
    public let description: String?
    public let provider: String?
    public let endpointUrl: String?
    public let documentationUrl: String?
    public let version: String?
    public let tags: [String]?
    public let capabilities: [String: JSONValue]?
    public let metadata: [String: JSONValue]?
    public let status: String?
    public let ratingAvg: Double?
    public let ratingCount: Int?
    public let skills: [DirectorySkill]?
    public let createdAt: String?
    public let updatedAt: String?
}

public struct DirectorySearchResult: Codable, Equatable, Sendable {
    public let id: String
    public let slug: String
    public let name: String
    public let description: String?
    public let provider: String?
    public let endpointUrl: String?
    public let documentationUrl: String?
    public let version: String?
    public let tags: [String]?
    public let capabilities: [String: JSONValue]?
    public let metadata: [String: JSONValue]?
    public let status: String?
    public let ratingAvg: Double?
    public let ratingCount: Int?
    public let skills: [DirectorySkill]?
    public let createdAt: String?
    public let updatedAt: String?
    public let relevanceScore: Double
}

public struct PublishToDirectoryRequest: Codable, Equatable, Sendable {
    public var sourceAgentName: String?
    public var slug: String?
    public var name: String
    public var description: String?
    public var provider: String?
    public var endpointUrl: String?
    public var documentationUrl: String?
    public var version: String?
    public var tags: [String]?
    public var capabilities: [String: JSONValue]?
    public var metadata: [String: JSONValue]?
    public var status: String?
    public var skills: [DirectorySkillInput]?

    public init(sourceAgentName: String? = nil, slug: String? = nil, name: String, description: String? = nil, provider: String? = nil, endpointUrl: String? = nil, documentationUrl: String? = nil, version: String? = nil, tags: [String]? = nil, capabilities: [String: JSONValue]? = nil, metadata: [String: JSONValue]? = nil, status: String? = nil, skills: [DirectorySkillInput]? = nil) {
        self.sourceAgentName = sourceAgentName
        self.slug = slug
        self.name = name
        self.description = description
        self.provider = provider
        self.endpointUrl = endpointUrl
        self.documentationUrl = documentationUrl
        self.version = version
        self.tags = tags
        self.capabilities = capabilities
        self.metadata = metadata
        self.status = status
        self.skills = skills
    }
}

public struct ImportSkillsRequest: Codable, Equatable, Sendable {
    public var agentName: String
    public var metadata: [String: JSONValue]?
    public var status: String?
    public var skills: [DirectorySkillInput]?

    public init(agentName: String, metadata: [String: JSONValue]? = nil, status: String? = nil, skills: [DirectorySkillInput]? = nil) {
        self.agentName = agentName
        self.metadata = metadata
        self.status = status
        self.skills = skills
    }
}

public struct SkillSearchQuery: Equatable, Sendable {
    public var q: String?
    public var limit: Int?

    public init(q: String? = nil, limit: Int? = nil) {
        self.q = q
        self.limit = limit
    }
}

public struct SkillSearchResult: Codable, Equatable, Sendable {
    public let agentName: String
    public let skillName: String
    public let description: String?
    public let tags: [String]?
    public let relevanceScore: Double
}

public struct RouteFeedbackRequest: Codable, Equatable, Sendable {
    public var agentName: String
    public var success: Bool
    public var error: String?

    public init(agentName: String, success: Bool, error: String? = nil) {
        self.agentName = agentName
        self.success = success
        self.error = error
    }
}

public struct RouteFeedbackResult: Codable, Equatable, Sendable {
    public let ok: Bool
}

public struct ListDirectoryQuery: Equatable, Sendable {
    public var status: String?
    public var limit: Int?

    public init(status: String? = nil, limit: Int? = nil) {
        self.status = status
        self.limit = limit
    }
}

public typealias UpdateDirectoryAgentRequest = PublishToDirectoryRequest

public struct DirectoryRating: Codable, Equatable, Sendable {
    public let id: String
    public let score: Int
    public let review: String?
    public let raterAgentId: String?
    public let raterAgentName: String?
    public let createdAt: String?
    public let updatedAt: String?
}

public struct RateDirectoryAgentRequest: Codable, Equatable, Sendable {
    public var score: Int
    public var review: String?

    public init(score: Int, review: String? = nil) {
        self.score = score
        self.review = review
    }
}

public struct RoutingWeights: Codable, Equatable, Sendable {
    public var skillMatch: Double?
    public var messageMatch: Double?
    public var tagMatch: Double?
    public var rating: Double?
    public var availability: Double?

    public init(skillMatch: Double? = nil, messageMatch: Double? = nil, tagMatch: Double? = nil, rating: Double? = nil, availability: Double? = nil) {
        self.skillMatch = skillMatch
        self.messageMatch = messageMatch
        self.tagMatch = tagMatch
        self.rating = rating
        self.availability = availability
    }
}

public struct RoutingConfig: Codable, Equatable, Sendable {
    public let weights: RoutingWeights
    public let circuitBreakerThreshold: Int?
    public let circuitBreakerCooldownSeconds: Int?
    public let updatedAt: String?
}

public struct UpdateRoutingConfigRequest: Codable, Equatable, Sendable {
    public var weights: RoutingWeights?
    public var circuitBreakerThreshold: Int?
    public var circuitBreakerCooldownSeconds: Int?

    public init(weights: RoutingWeights? = nil, circuitBreakerThreshold: Int? = nil, circuitBreakerCooldownSeconds: Int? = nil) {
        self.weights = weights
        self.circuitBreakerThreshold = circuitBreakerThreshold
        self.circuitBreakerCooldownSeconds = circuitBreakerCooldownSeconds
    }
}

public struct A2AAgentCardSkill: Codable, Equatable, Sendable {
    public var id: String?
    public var name: String
    public var description: String?
    public var tags: [String]?

    public init(id: String? = nil, name: String, description: String? = nil, tags: [String]? = nil) {
        self.id = id
        self.name = name
        self.description = description
        self.tags = tags
    }
}

public struct A2AAgentCard: Codable, Equatable, Sendable {
    public var name: String
    public var description: String?
    public var url: String
    public var version: String
    public var skills: [A2AAgentCardSkill]
    public var provider: [String: JSONValue]?
    public var capabilities: [String: JSONValue]?
    public var defaultInputModes: [String]?
    public var defaultOutputModes: [String]?
    public var documentationUrl: String?

    public init(name: String, description: String? = nil, url: String, version: String, skills: [A2AAgentCardSkill], provider: [String: JSONValue]? = nil, capabilities: [String: JSONValue]? = nil, defaultInputModes: [String]? = nil, defaultOutputModes: [String]? = nil, documentationUrl: String? = nil) {
        self.name = name
        self.description = description
        self.url = url
        self.version = version
        self.skills = skills
        self.provider = provider
        self.capabilities = capabilities
        self.defaultInputModes = defaultInputModes
        self.defaultOutputModes = defaultOutputModes
        self.documentationUrl = documentationUrl
    }
}

public struct RegisterA2AOptions: Codable, Equatable, Sendable {
    public var agentCardUrl: String?
    public var agentCard: A2AAgentCard?
    public var authScheme: String?
    public var authCredential: String?

    public init(agentCardUrl: String? = nil, agentCard: A2AAgentCard? = nil, authScheme: String? = nil, authCredential: String? = nil) {
        self.agentCardUrl = agentCardUrl
        self.agentCard = agentCard
        self.authScheme = authScheme
        self.authCredential = authCredential
    }
}

public struct RegisterA2AResponse: Codable, Equatable, Sendable {
    public let relayName: String
    public let relayToken: String
    public let webhookUrl: String
    public let certification: String
}

public struct A2AAgentRecord: Codable, Equatable, Sendable {
    public let id: String
    public let workspaceId: String?
    public let relayAgentId: String?
    public let relayName: String
    public let relayStatus: String?
    public let relayPersona: String?
    public let relayMetadata: [String: JSONValue]?
    public let agentCard: A2AAgentCard?
    public let externalUrl: String?
    public let authScheme: String?
    public let authCredential: String?
    public let status: String?
    public let messagesSent: Int?
    public let messagesRecv: Int?
    public let lastHealth: String?
    public let healthFailures: Int?
    public let createdAt: String?
    public let updatedAt: String?
}

public struct RemoveA2AAgentResponse: Codable, Equatable, Sendable {
    public let name: String
    public let removed: Bool
}

public struct SubmitCertificationRequest: Codable, Equatable, Sendable {
    public var target: String
    public var metadata: [String: JSONValue]?

    public init(target: String, metadata: [String: JSONValue]? = nil) {
        self.target = target
        self.metadata = metadata
    }
}

public struct MonitorCertificationRequest: Codable, Equatable, Sendable {
    public var id: String

    public init(id: String) {
        self.id = id
    }
}

public struct CertificationRun: Codable, Equatable, Sendable {
    public let id: String
    public let status: String
    public let createdAt: String?
    public let updatedAt: String?
    public let result: [String: JSONValue]?
}

public struct ConsoleMessagesQuery: Equatable, Sendable {
    public var limit: Int?
    public var before: String?
    public var agentId: String?
    public var channelId: String?
    public var conversationId: String?
    public var deliveryKind: String?

    public init(limit: Int? = nil, before: String? = nil, agentId: String? = nil, channelId: String? = nil, conversationId: String? = nil, deliveryKind: String? = nil) {
        self.limit = limit
        self.before = before
        self.agentId = agentId
        self.channelId = channelId
        self.conversationId = conversationId
        self.deliveryKind = deliveryKind
    }
}

public struct ConsoleMessageLog: Codable, Equatable, Sendable {
    public let id: String
    public let text: String?
    public let agentName: String?
    public let createdAt: String?
    public let data: [String: JSONValue]?
}

public struct ConsoleOverview: Codable, Equatable, Sendable {
    public let data: [String: JSONValue]?
}

public struct ConsoleAgentStat: Codable, Equatable, Sendable {
    public let agentId: String?
    public let agentName: String?
    public let messageCount: Int?
    public let cost: Double?
}

public struct ConsoleAgentStatsQuery: Equatable, Sendable {
    public var limit: Int?
    public init(limit: Int? = nil) {
        self.limit = limit
    }
}

public struct ConsoleWindowQuery: Equatable, Sendable {
    public var days: Int?
    public init(days: Int? = nil) {
        self.days = days
    }
}

public struct ConsoleCostStats: Codable, Equatable, Sendable {
    public let data: [String: JSONValue]?
}

// MARK: - Session events and WebSocket

public struct EmitSessionEventRequest: Codable, Equatable, Sendable {
    public var type: String
    public var payload: [String: JSONValue]?

    public init(type: String, payload: [String: JSONValue]? = nil) {
        self.type = type
        self.payload = payload
    }
}

public struct ListSessionEventsQuery: Equatable, Sendable {
    public var type: String?
    public var limit: Int?

    public init(type: String? = nil, limit: Int? = nil) {
        self.type = type
        self.limit = limit
    }
}

public struct SessionEvent: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let payload: [String: JSONValue]?
    public let createdAt: String?
}

public struct WsEvent: Codable, Equatable, Sendable {
    public let type: String
    public let payload: [String: JSONValue]

    public init(type: String, payload: [String: JSONValue] = [:]) {
        self.type = type
        self.payload = payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.type = try container.decode(String.self, forKey: DynamicCodingKey("type"))
        var payload: [String: JSONValue] = [:]
        for key in container.allKeys where key.stringValue != "type" {
            payload[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
        }
        self.payload = payload
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicCodingKey.self)
        try container.encode(type, forKey: DynamicCodingKey("type"))
        for (key, value) in payload {
            try container.encode(value, forKey: DynamicCodingKey(key))
        }
    }
}

// MARK: - Fleet nodes

public struct NodeCapability: Codable, Equatable, Sendable {
    public let name: String
    public let kind: String?
    public let metadata: [String: JSONValue]?

    public init(name: String, kind: String? = nil, metadata: [String: JSONValue]? = nil) {
        self.name = name
        self.kind = kind
        self.metadata = metadata
    }
}

public struct NodeRosterEntry: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let kind: String?
    public let deliveryAdapter: String?
    public let delivery: NodeDeliveryConfig?
    public let capabilities: [NodeCapability]
    public let tags: [String]
    public let version: String
    public let status: String
    public let live: Bool
    public let handlersLive: Bool
    public let load: Double
    public let activeAgents: Int
    public let maxAgents: Int
    public let lastHeartbeatAt: String?
    public let createdAt: String
}

public struct NodeDeliveryAuth: Codable, Equatable, Sendable {
    public let type: String
    public let token: String?
    public let headers: [String: String]?
    public let secret: String?
    public let signatureHeader: String?
    public let timestampHeader: String?
    public let signedPayload: String?
    public let encoding: String?
    public let prefix: String?

    public init(type: String, token: String? = nil, headers: [String: String]? = nil, secret: String? = nil, signatureHeader: String? = nil, timestampHeader: String? = nil, signedPayload: String? = nil, encoding: String? = nil, prefix: String? = nil) {
        self.type = type
        self.token = token
        self.headers = headers
        self.secret = secret
        self.signatureHeader = signatureHeader
        self.timestampHeader = timestampHeader
        self.signedPayload = signedPayload
        self.encoding = encoding
        self.prefix = prefix
    }
}

public struct HttpPushNodeDelivery: Codable, Equatable, Sendable {
    public let url: String
    public let ackMode: String?
    public let auth: NodeDeliveryAuth?

    public init(url: String, ackMode: String? = nil, auth: NodeDeliveryAuth? = nil) {
        self.url = url
        self.ackMode = ackMode
        self.auth = auth
    }
}

public enum NodeDeliveryConfig: Codable, Equatable, Sendable {
    case httpPush(HttpPushNodeDelivery)
    case raw([String: JSONValue])

    public init(httpPush delivery: HttpPushNodeDelivery) {
        self = .httpPush(delivery)
    }

    public init(raw value: [String: JSONValue]) {
        self = .raw(value)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let delivery = try? container.decode(HttpPushNodeDelivery.self) {
            self = .httpPush(delivery)
            return
        }
        self = .raw(try container.decode([String: JSONValue].self))
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .httpPush(let delivery):
            try delivery.encode(to: encoder)
        case .raw(let value):
            try value.encode(to: encoder)
        }
    }
}

extension NodeDeliveryConfig: ExpressibleByDictionaryLiteral {
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        self = .raw(Dictionary(uniqueKeysWithValues: elements))
    }
}

public struct CreateNodeRequest: Codable, Equatable, Sendable {
    public let nodeId: String?
    public let name: String
    public let kind: String?
    public let deliveryAdapter: String?
    public let delivery: NodeDeliveryConfig?
    public let capabilities: [String]?
    public let maxAgents: Int?
    public let tags: [String]?
    public let version: String?

    public init(nodeId: String? = nil, name: String, kind: String? = nil, deliveryAdapter: String? = nil, delivery: NodeDeliveryConfig? = nil, capabilities: [String]? = nil, maxAgents: Int? = nil, tags: [String]? = nil, version: String? = nil) {
        self.nodeId = nodeId
        self.name = name
        self.kind = kind
        self.deliveryAdapter = deliveryAdapter
        self.delivery = delivery
        self.capabilities = capabilities
        self.maxAgents = maxAgents
        self.tags = tags
        self.version = version
    }
}

public struct CreateNodeResponse: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let kind: String?
    public let deliveryAdapter: String?
    public let delivery: NodeDeliveryConfig?
    public let capabilities: [NodeCapability]
    public let tags: [String]
    public let version: String
    public let status: String
    public let live: Bool
    public let handlersLive: Bool
    public let load: Double
    public let activeAgents: Int
    public let maxAgents: Int
    public let lastHeartbeatAt: String?
    public let createdAt: String
    public let token: String
}

public struct NodeAgentBinding: Codable, Equatable, Sendable {
    public let id: String
    public let agentId: String
    public let agentName: String
    public let nodeId: String
    public let nodeName: String
    public let nodeKind: String
    public let status: String
    public let sessionRef: String?
    public let priority: Int
    public let createdAt: String
    public let updatedAt: String?
}

public struct BindAgentToNodeRequest: Codable, Equatable, Sendable {
    public let agentName: String
    public let sessionRef: String?
    public let priority: Int?

    public init(agentName: String, sessionRef: String? = nil, priority: Int? = nil) {
        self.agentName = agentName
        self.sessionRef = sessionRef
        self.priority = priority
    }
}

public struct NodeListQuery: Equatable, Sendable {
    public var capability: String?
    public var name: String?

    public init(capability: String? = nil, name: String? = nil) {
        self.capability = capability
        self.name = name
    }
}

// MARK: - Triggers

public struct Trigger: Codable, Equatable, Sendable {
    public let id: String
    public let channel: String?
    public let pattern: String?
    public let mention: Bool?
    public let actionName: String
    public let enabled: Bool
    public let lastTriggeredAt: String?
    public let createdAt: String
    public let updatedAt: String?
}

public struct CreateTriggerRequest: Codable, Equatable, Sendable {
    public var channel: String?
    public var pattern: String?
    public var mention: Bool?
    public var actionName: String
    public var enabled: Bool?

    public init(
        actionName: String,
        channel: String? = nil,
        pattern: String? = nil,
        mention: Bool? = nil,
        enabled: Bool? = nil
    ) {
        self.actionName = actionName
        self.channel = channel
        self.pattern = pattern
        self.mention = mention
        self.enabled = enabled
    }
}

public struct UpdateTriggerRequest: Codable, Equatable, Sendable {
    public var channel: String?
    public var pattern: String?
    public var mention: Bool?
    public var actionName: String?
    public var enabled: Bool?

    public init(
        channel: String? = nil,
        pattern: String? = nil,
        mention: Bool? = nil,
        actionName: String? = nil,
        enabled: Bool? = nil
    ) {
        self.channel = channel
        self.pattern = pattern
        self.mention = mention
        self.actionName = actionName
        self.enabled = enabled
    }
}

// MARK: - Workspace DM queries

public struct WorkspaceDMMessagesOptions: Equatable, Sendable {
    public var limit: Int?
    public var before: String?
    public var after: String?

    public init(limit: Int? = nil, before: String? = nil, after: String? = nil) {
        self.limit = limit
        self.before = before
        self.after = after
    }
}

public enum WsLifecycleEvent: Equatable, Sendable {
    case open
    case close
    case error(String)
    case reconnecting(attempt: Int)
    case permanentlyDisconnected(attempt: Int)
}
