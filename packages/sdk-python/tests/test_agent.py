"""Tests for AgentClient and AsyncAgentClient."""

import json

import httpx
import pytest
import respx

from relay_sdk.agent import AgentClient, AsyncAgentClient
from relay_sdk.client import AsyncHttpClient, HttpClient
from relay_sdk.models import (
    Agent,
    Channel,
    ChannelMemberInfo,
    ChannelReadStatus,
    DmConversationSummary,
    FileInfo,
    InboxResponse,
    MessageWithMeta,
    ReactionGroup,
    ReaderInfo,
    ThreadResponse,
    UploadResponse,
)

BASE = "https://test.relay.dev"
TOKEN = "at_test_token"


def ok(data):
    return httpx.Response(200, json={"ok": True, "data": data})


def request_json(request: httpx.Request):
    return json.loads(request.content.decode())


MSG = {
    "id": "m1",
    "agent_name": "Bot",
    "agent_id": "a1",
    "text": "Hello",
    "attachments": [],
    "created_at": "2025-01-01T00:00:00Z",
    "reply_count": 0,
    "reactions": [],
    "read_by_count": 0,
}

AGENT = {
    "id": "a1",
    "workspace_id": "w1",
    "name": "Bot",
    "type": "agent",
    "token_hash": "hash",
    "status": "offline",
    "persona": None,
    "metadata": {},
    "created_at": "2025-01-01T00:00:00Z",
    "last_seen": "2025-01-01T00:00:00Z",
}

CHANNEL = {
    "id": "c1",
    "workspace_id": "w1",
    "name": "general",
    "channel_type": 0,
    "topic": None,
    "created_by": None,
    "created_at": "2025-01-01T00:00:00Z",
    "is_archived": False,
}

MEMBER = {
    "agent_id": "a1",
    "agent_name": "Bot",
    "role": "member",
    "joined_at": "2025-01-01T00:00:00Z",
}


class TestAgentClientMessages:
    @respx.mock
    def test_me(self):
        route = respx.get(f"{BASE}/v1/agent").mock(return_value=ok(AGENT))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.me()
        assert isinstance(result, Agent)
        assert result.name == "Bot"
        assert route.called

    @respx.mock
    def test_send_strips_hash(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.send("#general", "Hello")
        assert isinstance(result, MessageWithMeta)
        assert route.called

    @respx.mock
    def test_send_without_hash(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.send("general", "Hello")
        assert route.called

    @respx.mock
    def test_send_with_attachments(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.send("general", "See file", attachments=["f1", "f2"])
        assert route.called
        assert request_json(route.calls[0].request) == {"text": "See file", "mode": "wait", "attachments": ["f1", "f2"]}

    @respx.mock
    def test_send_defaults_mode_wait(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.send("general", "Hello")
        assert route.called
        assert request_json(route.calls[0].request) == {"text": "Hello", "mode": "wait"}

    @respx.mock
    def test_send_forwards_steer_mode(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.send("general", "Hello", mode="steer")
        assert route.called
        assert route.calls[0].request.content == b'{"text":"Hello","mode":"steer"}'

    @respx.mock
    def test_messages_with_pagination(self):
        route = respx.get(f"{BASE}/v1/channels/general/messages").mock(return_value=ok([MSG]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.messages("#general", limit=10, before="m5")
        assert len(result) == 1
        assert isinstance(result[0], MessageWithMeta)
        req = route.calls[0].request
        assert "limit=10" in str(req.url)
        assert "before=m5" in str(req.url)

    @respx.mock
    def test_message_single(self):
        respx.get(f"{BASE}/v1/messages/m1").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.message("m1")
        assert result.id == "m1"

    @respx.mock
    def test_reply(self):
        route = respx.post(f"{BASE}/v1/messages/m1/replies").mock(return_value=ok(MSG))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.reply("m1", "Reply text")
        assert isinstance(result, MessageWithMeta)
        assert route.called

    @respx.mock
    def test_thread(self):
        thread_data = {"parent": MSG, "replies": [MSG]}
        respx.get(f"{BASE}/v1/messages/m1/replies").mock(return_value=ok(thread_data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.thread("m1")
        assert isinstance(result, ThreadResponse)
        assert len(result.replies) == 1


class TestAgentClientDMs:
    @respx.mock
    def test_dm(self):
        route = respx.post(f"{BASE}/v1/dm").mock(return_value=ok({"sent": True}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dm("Alice", "Hi")
        assert route.called
        assert route.calls[0].request.content == b'{"to":"Alice","text":"Hi","mode":"wait"}'

    @respx.mock
    def test_dm_steer_mode(self):
        route = respx.post(f"{BASE}/v1/dm").mock(return_value=ok({"sent": True}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dm("Alice", "Hi", mode="steer")
        assert route.calls[0].request.content == b'{"to":"Alice","text":"Hi","mode":"steer"}'

    @respx.mock
    def test_dm_with_attachments(self):
        route = respx.post(f"{BASE}/v1/dm").mock(return_value=ok({"sent": True}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dm("Alice", "Hi", attachments=["file_1", "file_2"])
        assert route.calls[0].request.content == b'{"to":"Alice","text":"Hi","mode":"wait","attachments":["file_1","file_2"]}'

    @respx.mock
    def test_dms_conversations(self):
        conv = {"id": "c1", "type": "1:1", "participants": ["A", "B"], "unread_count": 0}
        respx.get(f"{BASE}/v1/dm/conversations").mock(return_value=ok([conv]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.dms.conversations()
        assert len(result) == 1
        assert isinstance(result[0], DmConversationSummary)

    @respx.mock
    def test_dms_messages(self):
        respx.get(f"{BASE}/v1/dm/c1/messages").mock(return_value=ok([MSG]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.dms.messages("c1", limit=5)
        assert len(result) == 1

    @respx.mock
    def test_dms_create_group(self):
        route = respx.post(f"{BASE}/v1/dm/group").mock(return_value=ok({"id": "g1"}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dms.create_group(["A", "B", "C"], "Hello group")
        assert route.called

    @respx.mock
    def test_dms_send_message(self):
        route = respx.post(f"{BASE}/v1/dm/c1/messages").mock(return_value=ok({"sent": True}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dms.send_message("c1", "Hey")
        assert route.called
        assert route.calls[0].request.content == b'{"text":"Hey","mode":"wait"}'

    @respx.mock
    def test_dms_send_message_with_mode_and_attachments(self):
        route = respx.post(f"{BASE}/v1/dm/c1/messages").mock(return_value=ok({"sent": True}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dms.send_message("c1", "Hey", mode="steer", attachments=["file_1"])
        assert route.calls[0].request.content == b'{"text":"Hey","mode":"steer","attachments":["file_1"]}'

    @respx.mock
    def test_dms_add_participant(self):
        route = respx.post(f"{BASE}/v1/dm/c1/participants").mock(return_value=ok({"added": True}))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dms.add_participant("c1", "Alice")
        assert route.called

    @respx.mock
    def test_dms_remove_participant(self):
        route = respx.delete(f"{BASE}/v1/dm/c1/participants/Alice").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.dms.remove_participant("c1", "Alice")
        assert route.called


class TestAgentClientChannels:
    @respx.mock
    def test_channels_create(self):
        respx.post(f"{BASE}/v1/channels").mock(return_value=ok(CHANNEL))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.channels.create("general", topic="A topic")
        assert isinstance(result, Channel)

    @respx.mock
    def test_channels_list(self):
        respx.get(f"{BASE}/v1/channels").mock(return_value=ok([CHANNEL]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.channels.list()
        assert len(result) == 1

    @respx.mock
    def test_channels_list_include_archived(self):
        route = respx.get(f"{BASE}/v1/channels").mock(return_value=ok([]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.channels.list(include_archived=True)
        req = route.calls[0].request
        assert "include_archived=true" in str(req.url)

    @respx.mock
    def test_channels_get(self):
        data = {**CHANNEL, "members": [MEMBER]}
        respx.get(f"{BASE}/v1/channels/general").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.channels.get("general")
        assert result["name"] == "general"

    @respx.mock
    def test_channels_join(self):
        route = respx.post(f"{BASE}/v1/channels/general/join").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.channels.join("general")
        assert route.called

    @respx.mock
    def test_channels_leave(self):
        route = respx.post(f"{BASE}/v1/channels/general/leave").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.channels.leave("general")
        assert route.called

    @respx.mock
    def test_channels_set_topic(self):
        updated = {**CHANNEL, "topic": "New topic"}
        respx.patch(f"{BASE}/v1/channels/general/topic").mock(return_value=ok(updated))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.channels.set_topic("general", "New topic")
        assert result.topic == "New topic"

    @respx.mock
    def test_channels_archive(self):
        route = respx.delete(f"{BASE}/v1/channels/general").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.channels.archive("general")
        assert route.called

    @respx.mock
    def test_channels_invite(self):
        route = respx.post(f"{BASE}/v1/channels/general/invite").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.channels.invite("general", "Alice")
        assert route.called

    @respx.mock
    def test_channels_members(self):
        respx.get(f"{BASE}/v1/channels/general/members").mock(return_value=ok([MEMBER]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.channels.members("general")
        assert len(result) == 1
        assert isinstance(result[0], ChannelMemberInfo)


class TestAgentClientReactions:
    @respx.mock
    def test_react(self):
        route = respx.post(f"{BASE}/v1/messages/m1/reactions").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.react("m1", "👍")
        assert route.called

    @respx.mock
    def test_unreact(self):
        route = respx.delete(f"{BASE}/v1/messages/m1/reactions/%F0%9F%91%8D").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.unreact("m1", "👍")
        assert route.called

    @respx.mock
    def test_reactions(self):
        data = [{"emoji": "👍", "count": 1, "agents": ["Bot"]}]
        respx.get(f"{BASE}/v1/messages/m1/reactions").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.reactions("m1")
        assert len(result) == 1
        assert isinstance(result[0], ReactionGroup)


class TestAgentClientSearch:
    @respx.mock
    def test_search_basic(self):
        route = respx.get(f"{BASE}/v1/search").mock(return_value=ok([]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.search("hello")
        req = route.calls[0].request
        assert "q=hello" in str(req.url)

    @respx.mock
    def test_search_with_filters(self):
        route = respx.get(f"{BASE}/v1/search").mock(return_value=ok([]))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.search("hello", channel="general", from_="Bot", limit=5)
        req = route.calls[0].request
        url = str(req.url)
        assert "channel=general" in url
        assert "from=Bot" in url
        assert "limit=5" in url


class TestAgentClientInbox:
    @respx.mock
    def test_inbox(self):
        data = {"unread_channels": [], "mentions": [], "unread_dms": []}
        respx.get(f"{BASE}/v1/inbox").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.inbox()
        assert isinstance(result, InboxResponse)


class TestAgentClientReadReceipts:
    @respx.mock
    def test_mark_read(self):
        route = respx.post(f"{BASE}/v1/messages/m1/read").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.mark_read("m1")
        assert route.called

    @respx.mock
    def test_readers(self):
        data = [{"agent_name": "Bot", "agent_id": "a1", "read_at": "2025-01-01T00:00:00Z"}]
        respx.get(f"{BASE}/v1/messages/m1/readers").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.readers("m1")
        assert len(result) == 1
        assert isinstance(result[0], ReaderInfo)

    @respx.mock
    def test_read_status_strips_hash(self):
        data = [{"agent_name": "Bot", "last_read_id": "m1", "last_read_at": "2025-01-01T00:00:00Z"}]
        route = respx.get(f"{BASE}/v1/channels/general/read-status").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.read_status("#general")
        assert len(result) == 1
        assert isinstance(result[0], ChannelReadStatus)
        assert route.called


class TestAgentClientFiles:
    @respx.mock
    def test_files_upload(self):
        data = {"file_id": "f1", "upload_url": "https://s3/upload", "expires_at": "2025-01-01T01:00:00Z"}
        respx.post(f"{BASE}/v1/files/upload").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.files.upload("test.txt", "text/plain", 1024)
        assert isinstance(result, UploadResponse)

    @respx.mock
    def test_files_complete(self):
        data = {
            "file_id": "f1",
            "filename": "test.txt",
            "content_type": "text/plain",
            "size": 1024,
            "url": "https://s3/download",
            "uploaded_by": "Bot",
            "created_at": "2025-01-01T00:00:00Z",
        }
        respx.post(f"{BASE}/v1/files/f1/complete").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.files.complete("f1")
        assert isinstance(result, FileInfo)

    @respx.mock
    def test_files_get(self):
        data = {
            "file_id": "f1",
            "filename": "test.txt",
            "content_type": "text/plain",
            "size": 1024,
            "url": "https://s3/download",
            "uploaded_by": "Bot",
            "created_at": "2025-01-01T00:00:00Z",
        }
        respx.get(f"{BASE}/v1/files/f1").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.files.get("f1")
        assert result.filename == "test.txt"

    @respx.mock
    def test_files_delete(self):
        route = respx.delete(f"{BASE}/v1/files/f1").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.files.delete("f1")
        assert route.called

    @respx.mock
    def test_files_list(self):
        data = [{
            "file_id": "f1",
            "filename": "test.txt",
            "content_type": "text/plain",
            "size": 1024,
            "url": "https://s3/download",
            "uploaded_by": "Bot",
            "created_at": "2025-01-01T00:00:00Z",
        }]
        route = respx.get(f"{BASE}/v1/files").mock(return_value=ok(data))
        c = AgentClient(HttpClient(TOKEN, BASE))
        result = c.files.list(uploaded_by="Bot", limit=10)
        assert len(result) == 1
        req = route.calls[0].request
        assert "uploaded_by=Bot" in str(req.url)


# ── Async AgentClient tests ──


class TestAsyncAgentClient:
    @pytest.mark.asyncio
    @respx.mock
    async def test_me(self):
        route = respx.get(f"{BASE}/v1/agent").mock(return_value=ok(AGENT))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        result = await c.me()
        assert isinstance(result, Agent)
        assert result.name == "Bot"
        assert route.called
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_send(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        result = await c.send("#general", "Hello")
        assert isinstance(result, MessageWithMeta)
        assert route.calls[0].request.content == b'{"text":"Hello","mode":"wait"}'
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_send_steer_mode(self):
        route = respx.post(f"{BASE}/v1/channels/general/messages").mock(return_value=ok(MSG))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.send("#general", "Hello", mode="steer")
        assert route.calls[0].request.content == b'{"text":"Hello","mode":"steer"}'
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_messages(self):
        respx.get(f"{BASE}/v1/channels/general/messages").mock(return_value=ok([MSG]))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        result = await c.messages("general", limit=10)
        assert len(result) == 1
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_inbox(self):
        data = {"unread_channels": [], "mentions": [], "unread_dms": []}
        respx.get(f"{BASE}/v1/inbox").mock(return_value=ok(data))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        result = await c.inbox()
        assert isinstance(result, InboxResponse)
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_dm(self):
        route = respx.post(f"{BASE}/v1/dm").mock(return_value=ok({"sent": True}))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.dm("Alice", "Hi")
        assert route.called
        assert route.calls[0].request.content == b'{"to":"Alice","text":"Hi","mode":"wait"}'
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_dm_steer_mode(self):
        route = respx.post(f"{BASE}/v1/dm").mock(return_value=ok({"sent": True}))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.dm("Alice", "Hi", mode="steer")
        assert route.calls[0].request.content == b'{"to":"Alice","text":"Hi","mode":"steer"}'
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_dm_with_attachments(self):
        route = respx.post(f"{BASE}/v1/dm").mock(return_value=ok({"sent": True}))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.dm("Alice", "Hi", attachments=["file_1", "file_2"])
        assert route.calls[0].request.content == b'{"to":"Alice","text":"Hi","mode":"wait","attachments":["file_1","file_2"]}'
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_channels_create(self):
        respx.post(f"{BASE}/v1/channels").mock(return_value=ok(CHANNEL))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        result = await c.channels.create("general")
        assert isinstance(result, Channel)
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_react(self):
        route = respx.post(f"{BASE}/v1/messages/m1/reactions").mock(return_value=ok(None))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.react("m1", "👍")
        assert route.called
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_search(self):
        route = respx.get(f"{BASE}/v1/search").mock(return_value=ok([]))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.search("hello", channel="general")
        req = route.calls[0].request
        assert "q=hello" in str(req.url)
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_files_upload(self):
        data = {"file_id": "f1", "upload_url": "https://s3/upload", "expires_at": "2025-01-01T01:00:00Z"}
        respx.post(f"{BASE}/v1/files/upload").mock(return_value=ok(data))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        result = await c.files.upload("test.txt", "text/plain", 1024)
        assert isinstance(result, UploadResponse)
        await c.client.close()


class TestAgentPresence:
    @respx.mock
    def test_presence_mark_online_posts_heartbeat(self):
        route = respx.post(f"{BASE}/v1/agents/heartbeat").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.mark_online()
        assert route.called
        assert route.calls[0].request.content == b"{}"

    @respx.mock
    def test_presence_heartbeat_posts_heartbeat(self):
        route = respx.post(f"{BASE}/v1/agents/heartbeat").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.heartbeat()
        assert route.called

    @respx.mock
    def test_presence_mark_offline_posts_disconnect(self):
        route = respx.post(f"{BASE}/v1/agents/disconnect").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.mark_offline()
        assert route.called
        assert route.calls[0].request.content == b"{}"

    @respx.mock
    def test_presence_disconnect_alias_posts_disconnect(self):
        route = respx.post(f"{BASE}/v1/agents/disconnect").mock(return_value=ok(None))
        c = AgentClient(HttpClient(TOKEN, BASE))
        c.disconnect()
        assert route.called


class TestAsyncAgentPresence:
    @pytest.mark.asyncio
    @respx.mock
    async def test_presence_mark_online_posts_heartbeat(self):
        route = respx.post(f"{BASE}/v1/agents/heartbeat").mock(return_value=ok(None))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.mark_online()
        assert route.called
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_presence_mark_offline_posts_disconnect(self):
        route = respx.post(f"{BASE}/v1/agents/disconnect").mock(return_value=ok(None))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.mark_offline()
        assert route.called
        await c.client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_presence_disconnect_alias_posts_disconnect(self):
        route = respx.post(f"{BASE}/v1/agents/disconnect").mock(return_value=ok(None))
        c = AsyncAgentClient(AsyncHttpClient(TOKEN, BASE))
        await c.disconnect()
        assert route.called
        await c.client.close()
