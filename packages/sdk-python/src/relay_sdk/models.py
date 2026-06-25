"""Pydantic models mirroring @relaycast/types."""

from __future__ import annotations

from typing import Any, Literal

MessageInjectionMode = Literal["wait", "steer"]

from pydantic import BaseModel, Field


# ── Enums / Literals ──────────────────────────────────────────────

AgentType = Literal["agent", "human", "system"]
AgentStatus = Literal["online", "offline", "away"]
FileStatus = Literal["pending", "complete", "deleted"]
DmType = Literal["1:1", "group"]


# ── Agent ─────────────────────────────────────────────────────────

class Agent(BaseModel):
    id: str
    workspace_id: str
    name: str
    type: AgentType
    token_hash: str
    status: AgentStatus
    persona: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    last_seen: str


class CreateAgentRequest(BaseModel):
    name: str
    type: AgentType | None = None
    persona: str | None = None
    metadata: dict[str, Any] | None = None


class UpdateAgentRequest(BaseModel):
    status: AgentStatus | None = None
    persona: str | None = None
    metadata: dict[str, Any] | None = None


class AgentListQuery(BaseModel):
    status: AgentStatus | Literal["all"] | None = None


class CreateAgentResponse(BaseModel):
    id: str
    name: str
    token: str
    status: AgentStatus
    created_at: str


class TokenRotateResponse(BaseModel):
    token: str


# ── Observer tokens ───────────────────────────────────────────────

ObserverScope = Literal[
    "stream:read",
    "messages:read",
    "threads:read",
    "dms:read",
    "channels:read",
    "search:read",
    "agents:read",
    "nodes:read",
    "deliveries:read",
    "activity:read",
    "files:read",
    "reactions:read",
]


class ObserverTokenFilters(BaseModel):
    channel_ids: list[str] | None = None
    channel_names: list[str] | None = None
    include_dms: bool | None = None
    dm_conversation_ids: list[str] | None = None
    agent_ids: list[str] | None = None
    event_types: list[str] | None = None
    created_after: str | None = None


class CreateObserverTokenRequest(BaseModel):
    name: str
    scopes: list[ObserverScope]
    description: str | None = None
    filters: ObserverTokenFilters | None = None
    expires_at: str | None = None


class UpdateObserverTokenRequest(BaseModel):
    name: str | None = None
    scopes: list[ObserverScope] | None = None
    description: str | None = None
    filters: ObserverTokenFilters | None = None
    expires_at: str | None = None


class ObserverToken(BaseModel):
    id: str
    name: str
    description: str | None = None
    scopes: list[ObserverScope]
    filters: ObserverTokenFilters = Field(default_factory=ObserverTokenFilters)
    status: str
    expires_at: str | None = None
    created_at: str
    updated_at: str | None = None
    revoked_at: str | None = None
    last_used_at: str | None = None
    token: str | None = None


# ── Workspace ─────────────────────────────────────────────────────

class Workspace(BaseModel):
    id: str
    name: str
    api_key_hash: str
    system_prompt: str | None = None
    created_at: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class CreateWorkspaceRequest(BaseModel):
    name: str


class UpdateWorkspaceRequest(BaseModel):
    name: str | None = None
    system_prompt: str | None = None


class CreateWorkspaceResponse(BaseModel):
    workspace_id: str
    api_key: str
    created_at: str


# ── Channel ───────────────────────────────────────────────────────

class Channel(BaseModel):
    id: str
    workspace_id: str
    name: str
    channel_type: int
    topic: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_by: str | None = None
    created_at: str
    is_archived: bool


class ChannelMember(BaseModel):
    channel_id: str
    agent_id: str
    role: Literal["owner", "member"]
    joined_at: str
    last_read_id: str | None = None


class ChannelMemberInfo(BaseModel):
    agent_id: str
    agent_name: str
    role: Literal["owner", "member"]
    joined_at: str


class CreateChannelRequest(BaseModel):
    name: str
    topic: str | None = None
    metadata: dict[str, Any] | None = None


class UpdateChannelRequest(BaseModel):
    topic: str | None = None
    metadata: dict[str, Any] | None = None


class InviteRequest(BaseModel):
    agent: str


# ── Message ───────────────────────────────────────────────────────

class FileAttachment(BaseModel):
    file_id: str
    filename: str
    url: str
    size: int


class ReactionGroup(BaseModel):
    emoji: str
    count: int
    agents: list[str]


class MessageWithMeta(BaseModel):
    id: str
    agent_name: str
    agent_id: str
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    attachments: list[FileAttachment] = Field(default_factory=list)
    created_at: str
    reply_count: int = 0
    reactions: list[ReactionGroup] = Field(default_factory=list)
    read_by_count: int = 0
    injection_mode: MessageInjectionMode | None = None


class Message(BaseModel):
    id: str
    workspace_id: str
    channel_id: str
    agent_id: str
    thread_id: str | None = None
    body: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    has_attachments: bool
    created_at: str
    updated_at: str | None = None


class PostMessageRequest(BaseModel):
    text: str
    attachments: list[str] | None = None
    data: dict[str, Any] | None = None
    mode: MessageInjectionMode = "wait"


class MessageListQuery(BaseModel):
    limit: int | None = None
    before: str | None = None
    after: str | None = None


class ThreadReplyRequest(BaseModel):
    text: str
    data: dict[str, Any] | None = None


class ThreadResponse(BaseModel):
    parent: MessageWithMeta
    replies: list[MessageWithMeta]


# ── DMs ───────────────────────────────────────────────────────────

class DmConversation(BaseModel):
    id: str
    workspace_id: str
    channel_id: str
    dm_type: DmType
    name: str | None = None
    created_at: str


class DmParticipant(BaseModel):
    conversation_id: str
    agent_id: str
    joined_at: str
    left_at: str | None = None


class DmConversationSummary(BaseModel):
    id: str
    type: DmType
    name: str | None = None
    participants: list[str]
    last_message: str | None = None
    unread_count: int = 0


class SendDmRequest(BaseModel):
    to: str
    text: str
    mode: MessageInjectionMode = "wait"


class CreateGroupDmRequest(BaseModel):
    participants: list[str]
    name: str | None = None
    text: str


# ── Reactions ─────────────────────────────────────────────────────

class Reaction(BaseModel):
    id: str
    message_id: str
    agent_id: str
    emoji: str
    created_at: str


class AddReactionRequest(BaseModel):
    emoji: str


# ── Read Receipts ─────────────────────────────────────────────────

class ReadReceipt(BaseModel):
    message_id: str
    agent_id: str
    read_at: str


class ReaderInfo(BaseModel):
    agent_name: str
    agent_id: str
    read_at: str


class ChannelReadStatus(BaseModel):
    agent_name: str
    last_read_id: str | None = None
    last_read_at: str | None = None


# ── Files ─────────────────────────────────────────────────────────

class FileRecord(BaseModel):
    id: str
    workspace_id: str
    uploaded_by: str
    filename: str
    content_type: str
    size_bytes: int
    storage_key: str
    status: FileStatus
    created_at: str


class UploadRequest(BaseModel):
    filename: str
    content_type: str
    size: int


class UploadResponse(BaseModel):
    file_id: str
    upload_url: str
    expires_at: str


class FileInfo(BaseModel):
    file_id: str
    filename: str
    content_type: str
    size: int
    url: str
    uploaded_by: str
    created_at: str


# ── Inbox ─────────────────────────────────────────────────────────

class UnreadChannel(BaseModel):
    channel_name: str
    unread_count: int


class InboxMention(BaseModel):
    id: str
    channel_name: str
    agent_name: str
    text: str
    created_at: str


class UnreadDmLastMessage(BaseModel):
    id: str
    text: str
    created_at: str


class UnreadDm(BaseModel):
    conversation_id: str
    from_: str = Field(alias="from")
    unread_count: int
    last_message: UnreadDmLastMessage | None = None

    model_config = {"populate_by_name": True}


class RecentReaction(BaseModel):
    message_id: str
    channel_name: str
    emoji: str
    agent_name: str
    created_at: str


class InboxResponse(BaseModel):
    unread_channels: list[UnreadChannel]
    mentions: list[InboxMention]
    unread_dms: list[UnreadDm]
    recent_reactions: list[RecentReaction] = Field(default_factory=list)


# ── Durable Delivery ──────────────────────────────────────────────

# Durable delivery status lifecycle (mirrors packages/types/src/delivery.ts):
#   queued        -> durable row accepted, not yet sent to the current location
#   delivered     -> sent to the current location, awaiting cumulative ack
#   acked         -> recipient location acknowledged through the seq cursor (terminal success)
#   failed        -> explicit failure report (terminal failure)
#   dead_lettered -> TTL expiry / undeliverable (terminal failure)
DeliveryStatus = Literal["queued", "delivered", "acked", "failed", "dead_lettered"]


class DeliveryMessage(BaseModel):
    id: str
    channel_id: str
    agent_id: str | None = None
    agent_name: str | None = None
    text: str
    thread_id: str | None = None
    created_at: str


class Delivery(BaseModel):
    id: str
    message_id: str
    channel_id: str
    agent_id: str
    status: DeliveryStatus
    seq: int
    location_type: str
    location_node_id: str | None = None
    route_node_id: str | None = None
    route_node_kind: str | None = None
    route_node_role: str | None = None
    delivery_adapter: str | None = None
    dispatch_attempts: int = 0
    next_attempt_at: str | None = None
    last_dispatch_error: str | None = None
    mode: str
    reason: str | None = None
    priority: str
    retryable: bool | None = None
    error: str | None = None
    available_at: str | None = None
    deadline: str | None = None
    expires_at: str | None = None
    delivered_at: str | None = None
    acked_at: str | None = None
    dead_lettered_at: str | None = None
    created_at: str
    updated_at: str | None = None


class DeliveryItem(Delivery):
    message: DeliveryMessage | None = None


class FailDeliveryRequest(BaseModel):
    error: str | None = None
    retryable: bool | None = None


class DeferDeliveryRequest(BaseModel):
    available_at: str
    reason: str | None = None


# ── Nodes ─────────────────────────────────────────────────────────

NodeKind = Literal["ws", "http_push", "poll"]
NodeRole = Literal["direct", "broker"]
NodeAckMode = Literal["manual", "on_2xx", "response"]
NodeAuthType = Literal["none", "bearer", "static_headers", "hmac_sha256"]


class NodeCapability(BaseModel):
    name: str
    kind: str | None = None
    metadata: dict[str, Any] | None = None


class NodeDeliveryAuth(BaseModel):
    type: NodeAuthType
    token: str | None = None
    headers: dict[str, str] | None = None
    secret: str | None = None
    signature_header: str | None = None
    timestamp_header: str | None = None
    signed_payload: Literal["body", "timestamp.body"] | None = None
    encoding: Literal["hex"] | None = None
    prefix: str | None = None


class HttpPushNodeDelivery(BaseModel):
    url: str
    ack_mode: NodeAckMode | None = None
    auth: NodeDeliveryAuth | None = None


class NodeRosterEntry(BaseModel):
    id: str
    name: str
    kind: str | None = None
    role: str | None = None
    delivery_adapter: str | None = None
    delivery: dict[str, Any] | HttpPushNodeDelivery | None = None
    capabilities: list[NodeCapability] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    version: str
    status: str
    live: bool
    handlers_live: bool
    load: float
    active_agents: int
    max_agents: int
    last_heartbeat_at: str | None = None
    created_at: str


class CreateNodeRequest(BaseModel):
    node_id: str | None = None
    name: str
    kind: NodeKind | None = None
    role: NodeRole | None = None
    delivery_adapter: str | None = None
    delivery: dict[str, Any] | HttpPushNodeDelivery | None = None
    capabilities: list[str] | None = None
    max_agents: int | None = None
    tags: list[str] | None = None
    version: str | None = None


class CreateNodeResponse(NodeRosterEntry):
    token: str


class NodeAgentBinding(BaseModel):
    id: str
    agent_id: str
    agent_name: str
    node_id: str
    node_name: str
    node_kind: str
    node_role: str
    status: str
    session_ref: str | None = None
    priority: int
    created_at: str
    updated_at: str | None = None


class BindAgentToNodeRequest(BaseModel):
    agent_name: str
    session_ref: str | None = None
    priority: int | None = None


# ── A2A, Directory, Routing, Skills ───────────────────────────────


class A2aAgentCardSkill(BaseModel):
    id: str | None = None
    name: str
    description: str | None = None
    tags: list[str] | None = None


class A2aAgentCard(BaseModel):
    name: str
    description: str | None = None
    url: str
    version: str
    skills: list[A2aAgentCardSkill]
    provider: dict[str, Any] | None = None
    capabilities: dict[str, Any] | None = None
    default_input_modes: list[str] | None = None
    default_output_modes: list[str] | None = None
    documentation_url: str | None = None


class RegisterA2aOptions(BaseModel):
    agent_card_url: str | None = None
    agent_card: A2aAgentCard | None = None
    auth_scheme: str | None = None
    auth_credential: str | None = None


class RegisterA2aResponse(BaseModel):
    relay_name: str
    relay_token: str
    webhook_url: str
    certification: Literal["level_0", "level_1"]


class A2aAgentRecord(BaseModel):
    id: str
    workspace_id: str
    relay_agent_id: str
    relay_name: str
    relay_status: str
    relay_persona: str | None = None
    relay_metadata: dict[str, Any] | None = None
    agent_card: A2aAgentCard | None = None
    external_url: str
    auth_scheme: str | None = None
    auth_credential: str | None = None
    status: str
    messages_sent: int
    messages_recv: int
    last_health: str | None = None
    health_failures: int
    created_at: str
    updated_at: str


class RemoveA2aAgentResponse(BaseModel):
    name: str
    removed: bool


class DirectorySkillInput(BaseModel):
    id: str | None = None
    name: str
    description: str | None = None
    tags: list[str] | None = None
    metadata: dict[str, Any] | None = None


class DirectorySkill(BaseModel):
    id: str
    skill_id: str | None = None
    name: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DirectoryAgent(BaseModel):
    id: str
    source_agent_id: str | None = None
    slug: str
    name: str
    description: str | None = None
    provider: str | None = None
    endpoint_url: str | None = None
    documentation_url: str | None = None
    version: str | None = None
    tags: list[str] = Field(default_factory=list)
    capabilities: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    status: str
    rating_avg: float
    rating_count: int
    skills: list[DirectorySkill] = Field(default_factory=list)
    created_at: str
    updated_at: str


class DirectorySearchResult(DirectoryAgent):
    relevance_score: float


class PublishToDirectoryRequest(BaseModel):
    source_agent_name: str | None = None
    slug: str | None = None
    name: str
    description: str | None = None
    provider: str | None = None
    endpoint_url: str | None = None
    documentation_url: str | None = None
    version: str | None = None
    tags: list[str] | None = None
    capabilities: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    status: str | None = None
    skills: list[DirectorySkillInput] | None = None


class ImportSkillsRequest(BaseModel):
    agent_name: str
    metadata: dict[str, Any] | None = None
    status: str | None = None
    skills: list[DirectorySkillInput] | None = None


class RouteResult(BaseModel):
    agent_name: str
    score: float
    fallback: bool


class RoutingWeights(BaseModel):
    skill_match: float
    message_match: float
    tag_match: float
    rating: float
    availability: float


class RoutingConfig(BaseModel):
    weights: RoutingWeights
    circuit_breaker_threshold: int
    circuit_breaker_cooldown_seconds: int
    updated_at: str | None = None


class UpdateRoutingWeightsRequest(BaseModel):
    skill_match: float | None = None
    message_match: float | None = None
    tag_match: float | None = None
    rating: float | None = None
    availability: float | None = None


class UpdateRoutingConfigRequest(BaseModel):
    weights: UpdateRoutingWeightsRequest | None = None
    circuit_breaker_threshold: int | None = None
    circuit_breaker_cooldown_seconds: int | None = None


class UpdateDirectoryAgentRequest(PublishToDirectoryRequest):
    name: str | None = None  # type: ignore[assignment]
    source_agent_name: str | None = None


class DirectoryRating(BaseModel):
    id: str
    score: int
    review: str | None = None
    rater_agent_id: str
    rater_agent_name: str
    created_at: str
    updated_at: str | None = None


class RateDirectoryAgentRequest(BaseModel):
    score: int
    review: str | None = None


class RouteFeedbackRequest(BaseModel):
    agent_name: str
    success: bool
    error: str | None = None


class RouteFeedbackResult(BaseModel):
    ok: bool


class SkillSearchResult(BaseModel):
    agent_name: str
    skill_name: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)
    relevance_score: float


# ── API Response Wrappers ────────────────────────────────────────

class ApiErrorDetail(BaseModel):
    code: str
    message: str


class ApiSuccess(BaseModel):
    ok: Literal[True]
    data: Any


class ApiError(BaseModel):
    ok: Literal[False]
    error: ApiErrorDetail


# ── WebSocket Events ─────────────────────────────────────────────

class MessageEventPayload(BaseModel):
    id: str
    agent_name: str
    text: str
    attachments: list[FileAttachment] = Field(default_factory=list)
    injection_mode: MessageInjectionMode | None = None


class MessageUpdatedPayload(BaseModel):
    id: str
    agent_name: str
    text: str


class ThreadReplyPayload(BaseModel):
    id: str
    agent_name: str
    text: str


class DmEventPayload(BaseModel):
    id: str
    agent_name: str
    text: str


class AgentEventPayload(BaseModel):
    name: str


class ChannelEventPayload(BaseModel):
    name: str
    topic: str | None = None


class ChannelArchivedPayload(BaseModel):
    name: str


class FileEventPayload(BaseModel):
    file_id: str
    filename: str
    uploaded_by: str


class MessageCreatedEvent(BaseModel):
    type: Literal["message.created"]
    channel: str
    message: MessageEventPayload


class MessageUpdatedEvent(BaseModel):
    type: Literal["message.updated"]
    channel: str
    message: MessageUpdatedPayload


class ThreadReplyEvent(BaseModel):
    type: Literal["thread.reply"]
    parent_id: str
    message: ThreadReplyPayload


class MessageReactedEvent(BaseModel):
    type: Literal["message.reacted"]
    message_id: str
    emoji: str
    agent_name: str
    action: Literal["added", "removed"] | None = None


class DmReceivedEvent(BaseModel):
    type: Literal["dm.received"]
    conversation_id: str
    message: DmEventPayload


class GroupDmReceivedEvent(BaseModel):
    type: Literal["group_dm.received"]
    conversation_id: str
    message: DmEventPayload


class AgentStatusEvent(BaseModel):
    type: Literal[
        "agent.status.changed",
        "agent.status.idle",
        "agent.status.active",
        "agent.status.blocked",
        "agent.status.waiting",
        "agent.status.offline",
    ]
    agent: AgentEventPayload
    status: Literal["active", "idle", "blocked", "waiting", "offline"]


class ChannelCreatedEvent(BaseModel):
    type: Literal["channel.created"]
    channel: ChannelEventPayload


class ChannelArchivedEvent(BaseModel):
    type: Literal["channel.archived"]
    channel: ChannelArchivedPayload


class MessageReadEvent(BaseModel):
    type: Literal["message.read"]
    message_id: str
    agent_name: str
    read_at: str


class FileUploadedEvent(BaseModel):
    type: Literal["file.uploaded"]
    file: FileEventPayload


class PongEvent(BaseModel):
    type: Literal["pong"]


ServerEvent = (
    MessageCreatedEvent
    | MessageUpdatedEvent
    | ThreadReplyEvent
    | MessageReactedEvent
    | DmReceivedEvent
    | GroupDmReceivedEvent
    | AgentStatusEvent
    | ChannelCreatedEvent
    | ChannelArchivedEvent
    | MessageReadEvent
    | FileUploadedEvent
    | PongEvent
)

ServerEventType = Literal[
    "message.created",
    "message.updated",
    "thread.reply",
    "message.reacted",
    "dm.received",
    "group_dm.received",
    "agent.status.changed",
    "agent.status.idle",
    "agent.status.active",
    "agent.status.blocked",
    "agent.status.waiting",
    "agent.status.offline",
    "channel.created",
    "channel.archived",
    "message.read",
    "file.uploaded",
    "pong",
]

ClientEventType = Literal["subscribe", "unsubscribe", "ping"]
