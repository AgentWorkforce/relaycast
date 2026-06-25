import pytest
from pydantic import ValidationError

from relay_sdk.models import (
    Agent,
    AgentListQuery,
    AgentStatusEvent,
    ApiError,
    ApiSuccess,
    Channel,
    ChannelArchivedEvent,
    ChannelCreatedEvent,
    CreateAgentRequest,
    CreateAgentResponse,
    DmConversationSummary,
    DmReceivedEvent,
    FileAttachment,
    FileUploadedEvent,
    GroupDmReceivedEvent,
    InboxMention,
    InboxResponse,
    MessageCreatedEvent,
    MessageReactedEvent,
    MessageReadEvent,
    MessageUpdatedEvent,
    MessageWithMeta,
    PongEvent,
    ReactionGroup,
    RecentReaction,
    ThreadReplyEvent,
    ThreadResponse,
    UnreadChannel,
    UnreadDm,
    Workspace,
)


def _agent_dict(**overrides):
    data = {
        "id": "ag_1",
        "workspace_id": "ws_1",
        "name": "Alpha",
        "type": "agent",
        "token_hash": "th_1",
        "status": "online",
        "persona": None,
        "metadata": {"k": "v"},
        "created_at": "2026-02-08T00:00:00Z",
        "last_seen": "2026-02-08T00:00:01Z",
    }
    data.update(overrides)
    return data


def _message_with_meta_dict(**overrides):
    data = {
        "id": "m_1",
        "agent_name": "Alpha",
        "agent_id": "ag_1",
        "text": "hello",
        "attachments": [
            {"file_id": "f_1", "filename": "a.txt", "content_type": "text/plain", "size_bytes": 12}
        ],
        "created_at": "2026-02-08T00:00:00Z",
        "reply_count": 0,
        "reactions": [{"emoji": ":+1:", "count": 2, "agents": ["ag_1", "ag_2"]}],
        "read_by_count": 0,
    }
    data.update(overrides)
    return data


def test_agent_model_creation_and_validation():
    agent = Agent(**_agent_dict())
    assert agent.id == "ag_1"
    assert agent.type == "agent"
    assert agent.status == "online"
    assert agent.metadata == {"k": "v"}


def test_agent_metadata_default_factory_is_not_shared():
    d1 = _agent_dict()
    d2 = _agent_dict(id="ag_2")
    d1.pop("metadata")
    d2.pop("metadata")
    a1 = Agent(**d1)
    a2 = Agent(**d2)
    assert a1.metadata == {}
    assert a2.metadata == {}
    a1.metadata["x"] = 1
    assert a2.metadata == {}


def test_agent_status_literal_validation_rejects_invalid_value():
    with pytest.raises(ValidationError):
        Agent(**_agent_dict(status="busy"))


def test_agent_type_literal_validation_rejects_invalid_value():
    with pytest.raises(ValidationError):
        Agent(**_agent_dict(type="bot"))


def test_agent_list_query_accepts_all():
    q = AgentListQuery(status="all")
    assert q.status == "all"


def test_agent_list_query_rejects_unknown_status():
    with pytest.raises(ValidationError):
        AgentListQuery(status="busy")


def test_create_agent_request_optional_fields_can_be_omitted():
    req = CreateAgentRequest(name="Alpha")
    assert req.name == "Alpha"
    assert req.type is None
    assert req.persona is None
    assert req.metadata is None


def test_create_agent_request_allows_explicit_none_metadata():
    req = CreateAgentRequest(name="Alpha", metadata=None)
    assert req.metadata is None


def test_create_agent_request_rejects_invalid_type():
    with pytest.raises(ValidationError):
        CreateAgentRequest(name="Alpha", type="bot")


def test_create_agent_response_fields():
    resp = CreateAgentResponse(
        id="ag_1",
        name="Alpha",
        token="at_123",
        status="offline",
        created_at="2026-02-08T00:00:00Z",
    )
    assert resp.token == "at_123"
    assert resp.status == "offline"


def test_create_agent_response_rejects_invalid_status():
    with pytest.raises(ValidationError):
        CreateAgentResponse(
            id="ag_1",
            name="Alpha",
            token="at_123",
            status="busy",
            created_at="2026-02-08T00:00:00Z",
        )


def test_workspace_model_creation():
    ws = Workspace(
        id="ws_1",
        name="Test",
        api_key_hash="akh_1",
        system_prompt=None,
        created_at="2026-02-08T00:00:00Z",
    )
    assert ws.name == "Test"
    assert ws.metadata == {}


def test_workspace_metadata_default_factory_is_not_shared():
    ws1 = Workspace(
        id="ws_1",
        name="Test",
        api_key_hash="akh_1",
        created_at="2026-02-08T00:00:00Z",
    )
    ws2 = Workspace(
        id="ws_2",
        name="Test2",
        api_key_hash="akh_2",
        created_at="2026-02-08T00:00:00Z",
    )
    ws1.metadata["x"] = 1
    assert ws2.metadata == {}


def test_channel_model_creation():
    ch = Channel(
        id="ch_1",
        workspace_id="ws_1",
        name="general",
        channel_type=0,
        topic="t",
        created_by="ag_1",
        created_at="2026-02-08T00:00:00Z",
        is_archived=False,
    )
    assert ch.name == "general"
    assert ch.is_archived is False


def test_message_with_meta_creation_with_nested_attachment_and_reaction_group():
    msg = MessageWithMeta(**_message_with_meta_dict())
    assert msg.attachments and isinstance(msg.attachments[0], FileAttachment)
    assert msg.attachments[0].content_type == "text/plain"
    assert msg.attachments[0].size_bytes == 12
    assert msg.reactions and isinstance(msg.reactions[0], ReactionGroup)
    assert msg.reactions[0].agents == ["ag_1", "ag_2"]


def test_file_attachment_requires_canonical_fields():
    attachment = FileAttachment(
        file_id="f_1",
        filename="a.txt",
        content_type="text/plain",
        size_bytes=12,
    )
    assert attachment.content_type == "text/plain"

    with pytest.raises(ValidationError):
        FileAttachment(file_id="f_1", filename="a.txt", url="https://x/y", size=12)


def test_message_with_meta_accepts_injection_mode():
    msg = MessageWithMeta(**_message_with_meta_dict(injection_mode="steer"))
    assert msg.injection_mode == "steer"


def test_message_with_meta_defaults_empty_lists_and_counters():
    msg = MessageWithMeta(
        id="m_1",
        agent_name="Alpha",
        agent_id="ag_1",
        text="hi",
        created_at="2026-02-08T00:00:00Z",
    )
    assert msg.attachments == []
    assert msg.reactions == []
    assert msg.reply_count == 0
    assert msg.read_by_count == 0


def test_thread_response_creation():
    tr = ThreadResponse(
        parent=MessageWithMeta(**_message_with_meta_dict(id="m_parent")),
        replies=[
            MessageWithMeta(**_message_with_meta_dict(id="m_r1", text="r1")),
            MessageWithMeta(**_message_with_meta_dict(id="m_r2", text="r2")),
        ],
    )
    assert tr.parent.id == "m_parent"
    assert [r.id for r in tr.replies] == ["m_r1", "m_r2"]


def test_dm_conversation_summary_fields_and_defaults():
    s = DmConversationSummary(id="dm_1", type="1:1", participants=["ag_1", "ag_2"])
    assert s.type == "1:1"
    assert s.unread_count == 0
    assert s.last_message is None


def test_inbox_response_with_nested_unread_channel_mention_and_unread_dm():
    inbox = InboxResponse(
        unread_channels=[UnreadChannel(channel_name="general", unread_count=2)],
        mentions=[
            InboxMention(
                id="m_1",
                channel_name="general",
                agent_name="Alpha",
                text="@you hi",
                created_at="2026-02-08T00:00:00Z",
            )
        ],
        unread_dms=[
            UnreadDm.model_validate(
                {
                    "conversation_id": "dm_1",
                    "from": "ag_2",
                    "unread_count": 5,
                    "last_message": {
                        "id": "m_9",
                        "text": "yo",
                        "created_at": "2026-02-08T00:00:00Z",
                    },
                }
            )
        ],
        recent_reactions=[
            RecentReaction(
                message_id="m_1",
                channel_name="general",
                emoji="👍",
                agent_name="Alpha",
                created_at="2026-02-08 00:00:00",
            )
        ],
    )
    assert inbox.unread_channels[0].unread_count == 2
    assert inbox.mentions[0].text == "@you hi"
    assert inbox.unread_dms[0].from_ == "ag_2"
    assert inbox.unread_dms[0].last_message is not None
    assert inbox.unread_dms[0].last_message.text == "yo"
    assert inbox.recent_reactions[0].emoji == "👍"


def test_unread_dm_alias_from_maps_to_from_attribute():
    dm = UnreadDm.model_validate({"conversation_id": "dm_1", "from": "ag_2", "unread_count": 1})
    assert dm.from_ == "ag_2"
    assert dm.model_dump(by_alias=True)["from"] == "ag_2"


def test_unread_dm_populate_by_name_allows_from_():
    dm = UnreadDm(conversation_id="dm_1", from_="ag_2", unread_count=1)
    assert dm.from_ == "ag_2"
    assert dm.model_dump(by_alias=True)["from"] == "ag_2"


def test_api_success_ok_literal_is_enforced():
    ok = ApiSuccess(ok=True, data={"x": 1})
    assert ok.ok is True
    with pytest.raises(ValidationError):
        ApiSuccess(ok=False, data={"x": 1})


def test_api_error_ok_literal_is_enforced():
    err = ApiError(ok=False, error={"code": "not_found", "message": "nope"})
    assert err.ok is False
    with pytest.raises(ValidationError):
        ApiError(ok=True, error={"code": "not_found", "message": "nope"})


def test_ws_message_created_event_model():
    ev = MessageCreatedEvent.model_validate(
        {
            "type": "message.created",
            "channel": "general",
            "message": {
                "id": "m_1",
                "agent_name": "Alpha",
                "text": "hi",
                "attachments": [
                    {"file_id": "f_1", "filename": "a.txt", "content_type": "text/plain", "size_bytes": 1}
                ],
                "injection_mode": "wait",
            },
        }
    )
    assert ev.type == "message.created"
    assert ev.message.attachments[0].file_id == "f_1"
    assert ev.message.attachments[0].size_bytes == 1
    assert ev.message.injection_mode == "wait"


def test_ws_message_created_event_rejects_wrong_type_literal():
    with pytest.raises(ValidationError):
        MessageCreatedEvent.model_validate(
            {"type": "message.updated", "channel": "general", "message": {"id": "m", "agent_name": "a", "text": "t"}}
        )


def test_ws_message_updated_event_model():
    ev = MessageUpdatedEvent.model_validate(
        {"type": "message.updated", "channel": "general", "message": {"id": "m_1", "agent_name": "Alpha", "text": "x"}}
    )
    assert ev.type == "message.updated"
    assert ev.message.text == "x"


def test_ws_thread_reply_event_model():
    ev = ThreadReplyEvent.model_validate(
        {"type": "thread.reply", "parent_id": "m_parent", "message": {"id": "m_r1", "agent_name": "Alpha", "text": "r"}}
    )
    assert ev.type == "thread.reply"
    assert ev.parent_id == "m_parent"


def test_ws_message_reacted_added_event_model():
    ev = MessageReactedEvent.model_validate(
        {"type": "message.reacted", "message_id": "m_1", "emoji": ":+1:", "agent_name": "Alpha", "action": "added"}
    )
    assert ev.type == "message.reacted"
    assert ev.emoji == ":+1:"
    assert ev.action == "added"


def test_ws_message_reacted_removed_event_model():
    ev = MessageReactedEvent.model_validate(
        {"type": "message.reacted", "message_id": "m_1", "emoji": ":+1:", "agent_name": "Alpha", "action": "removed"}
    )
    assert ev.type == "message.reacted"
    assert ev.message_id == "m_1"
    assert ev.action == "removed"


def test_ws_dm_received_event_model():
    ev = DmReceivedEvent.model_validate(
        {"type": "dm.received", "conversation_id": "dm_1", "message": {"id": "m_1", "agent_name": "Alpha", "text": "hi"}}
    )
    assert ev.type == "dm.received"
    assert ev.message.id == "m_1"


def test_ws_group_dm_received_event_model():
    ev = GroupDmReceivedEvent.model_validate(
        {
            "type": "group_dm.received",
            "conversation_id": "dm_g1",
            "message": {"id": "m_1", "agent_name": "Alpha", "text": "hi"},
        }
    )
    assert ev.type == "group_dm.received"
    assert ev.conversation_id == "dm_g1"


def test_ws_agent_status_active_event_model():
    ev = AgentStatusEvent.model_validate({"type": "agent.status.active", "agent": {"name": "Alpha"}, "status": "active"})
    assert ev.type == "agent.status.active"
    assert ev.agent.name == "Alpha"


def test_ws_agent_status_offline_event_model():
    ev = AgentStatusEvent.model_validate({"type": "agent.status.offline", "agent": {"name": "Alpha"}, "status": "offline"})
    assert ev.type == "agent.status.offline"
    assert ev.agent.name == "Alpha"


def test_ws_channel_created_event_model():
    ev = ChannelCreatedEvent.model_validate({"type": "channel.created", "channel": {"name": "general", "topic": "t"}})
    assert ev.type == "channel.created"
    assert ev.channel.topic == "t"


def test_ws_channel_archived_event_model():
    ev = ChannelArchivedEvent.model_validate({"type": "channel.archived", "channel": {"name": "general"}})
    assert ev.type == "channel.archived"
    assert ev.channel.name == "general"


def test_ws_message_read_event_model():
    ev = MessageReadEvent.model_validate(
        {"type": "message.read", "message_id": "m_1", "agent_name": "Alpha", "read_at": "2026-02-08T00:00:00Z"}
    )
    assert ev.type == "message.read"
    assert ev.read_at.endswith("Z")


def test_ws_file_uploaded_event_model():
    ev = FileUploadedEvent.model_validate(
        {"type": "file.uploaded", "file": {"file_id": "f_1", "filename": "a.txt", "uploaded_by": "ag_1"}}
    )
    assert ev.type == "file.uploaded"
    assert ev.file.uploaded_by == "ag_1"


def test_ws_pong_event_model():
    ev = PongEvent.model_validate({"type": "pong"})
    assert ev.type == "pong"
