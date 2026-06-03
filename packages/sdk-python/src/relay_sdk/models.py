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


class UnreadDm(BaseModel):
    conversation_id: str
    from_: str = Field(alias="from")
    unread_count: int
    last_message: str | None = None

    model_config = {"populate_by_name": True}


class InboxResponse(BaseModel):
    unread_channels: list[UnreadChannel]
    mentions: list[InboxMention]
    unread_dms: list[UnreadDm]


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


ReactionAddedEvent = MessageReactedEvent
ReactionRemovedEvent = MessageReactedEvent


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


AgentOnlineEvent = AgentStatusEvent
AgentOfflineEvent = AgentStatusEvent


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
