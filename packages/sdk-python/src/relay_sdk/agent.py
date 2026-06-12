"""Agent client — messaging, channels, DMs, files, reactions, search, inbox."""

from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote

from .client import AsyncHttpClient, HttpClient
from .models import (
    Agent,
    Channel,
    ChannelMemberInfo,
    ChannelReadStatus,
    CreateChannelRequest,
    CreateGroupDmRequest,
    DmConversationSummary,
    Delivery,
    DeliveryItem,
    DeliveryStatus,
    DeferDeliveryRequest,
    FailDeliveryRequest,
    FileInfo,
    InboxResponse,
    MessageInjectionMode,
    MessageWithMeta,
    ReactionGroup,
    ReaderInfo,
    ThreadResponse,
    UploadRequest,
    UploadResponse,
)


def _strip_hash(channel: str) -> str:
    return channel[1:] if channel.startswith("#") else channel


def _enc(value: str) -> str:
    return quote(value, safe="")


# ── Namespace helpers ────────────────────────────────────────────


class _DmsNamespace:
    """Sync DM sub-operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def conversations(self) -> list[DmConversationSummary]:
        result = self._client.get("/v1/dm/conversations")
        return [DmConversationSummary.model_validate(r) for r in result]

    def messages(
        self,
        conversation_id: str,
        *,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[MessageWithMeta]:
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        if before:
            query["before"] = before
        if after:
            query["after"] = after
        result = self._client.get(
            f"/v1/dm/{_enc(conversation_id)}/messages", query or None
        )
        return [MessageWithMeta.model_validate(m) for m in result]

    def create_group(self, participants: list[str], text: str, *, name: str | None = None) -> Any:
        data = CreateGroupDmRequest(participants=participants, text=text, name=name)
        return self._client.post("/v1/dm/group", data.model_dump(exclude_none=True))

    def send_message(
        self,
        conversation_id: str,
        text: str,
        *,
        mode: MessageInjectionMode = "wait",
        attachments: list[str] | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"text": text, "mode": mode}
        if attachments:
            payload["attachments"] = attachments
        return self._client.post(
            f"/v1/dm/{_enc(conversation_id)}/messages", payload
        )

    def add_participant(self, conversation_id: str, agent: str) -> Any:
        return self._client.post(
            f"/v1/dm/{_enc(conversation_id)}/participants", {"agent": agent}
        )

    def remove_participant(self, conversation_id: str, agent: str) -> None:
        self._client.delete(
            f"/v1/dm/{_enc(conversation_id)}/participants/{_enc(agent)}"
        )


class _ChannelsNamespace:
    """Sync channel sub-operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def create(self, name: str, *, topic: str | None = None) -> Channel:
        data = CreateChannelRequest(name=name, topic=topic)
        result = self._client.post("/v1/channels", data.model_dump(exclude_none=True))
        return Channel.model_validate(result)

    def list(self, *, include_archived: bool = False) -> list[Channel]:
        query: dict[str, str] = {}
        if include_archived:
            query["include_archived"] = "true"
        result = self._client.get("/v1/channels", query or None)
        return [Channel.model_validate(c) for c in result]

    def get(self, name: str) -> dict[str, Any]:
        return self._client.get(f"/v1/channels/{_enc(name)}")

    def join(self, name: str) -> Any:
        return self._client.post(f"/v1/channels/{_enc(name)}/join")

    def leave(self, name: str) -> None:
        self._client.post(f"/v1/channels/{_enc(name)}/leave")

    def set_topic(self, name: str, topic: str) -> Channel:
        result = self._client.patch(f"/v1/channels/{_enc(name)}", {"topic": topic})
        return Channel.model_validate(result)

    def archive(self, name: str) -> None:
        self._client.delete(f"/v1/channels/{_enc(name)}")

    def invite(self, channel: str, agent: str) -> Any:
        return self._client.post(f"/v1/channels/{_enc(channel)}/invite", {"agent": agent})

    def members(self, name: str) -> list[ChannelMemberInfo]:
        result = self._client.get(f"/v1/channels/{_enc(name)}/members")
        return [ChannelMemberInfo.model_validate(m) for m in result]

    def update(self, name: str, *, topic: str | None = None, metadata: dict[str, Any] | None = None) -> Channel:
        body: dict[str, Any] = {}
        if topic is not None:
            body["topic"] = topic
        if metadata is not None:
            body["metadata"] = metadata
        result = self._client.patch(f"/v1/channels/{_enc(name)}", body)
        return Channel.model_validate(result)

    def mute(self, name: str) -> None:
        self._client.post(f"/v1/channels/{_enc(name)}/mute", {})

    def unmute(self, name: str) -> None:
        self._client.post(f"/v1/channels/{_enc(name)}/unmute", {})


class _ActionsNamespace:
    """Sync action invocation sub-operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def invoke(self, name: str, input: dict[str, Any] | None = None) -> Any:
        return self._client.post(f"/v1/actions/{_enc(name)}/invoke", {"input": input})

    def complete_invocation(self, name: str, invocation_id: str, data: dict[str, Any]) -> Any:
        return self._client.post(
            f"/v1/actions/{_enc(name)}/invocations/{_enc(invocation_id)}/complete",
            data,
        )

    def get_invocation(self, name: str, invocation_id: str) -> Any:
        return self._client.get(f"/v1/actions/{_enc(name)}/invocations/{_enc(invocation_id)}")


class _FilesNamespace:
    """Sync file sub-operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def upload(self, filename: str, content_type: str, size: int) -> UploadResponse:
        data = UploadRequest(filename=filename, content_type=content_type, size=size)
        result = self._client.post("/v1/files/upload", data.model_dump())
        return UploadResponse.model_validate(result)

    def complete(self, file_id: str) -> FileInfo:
        result = self._client.post(f"/v1/files/{_enc(file_id)}/complete")
        return FileInfo.model_validate(result)

    def get(self, file_id: str) -> FileInfo:
        result = self._client.get(f"/v1/files/{_enc(file_id)}")
        return FileInfo.model_validate(result)

    def delete(self, file_id: str) -> None:
        self._client.delete(f"/v1/files/{_enc(file_id)}")

    def list(self, *, uploaded_by: str | None = None, limit: int | None = None) -> list[FileInfo]:
        query: dict[str, str] = {}
        if uploaded_by:
            query["uploaded_by"] = uploaded_by
        if limit:
            query["limit"] = str(limit)
        result = self._client.get("/v1/files", query or None)
        return [FileInfo.model_validate(f) for f in result]


class _PresenceNamespace:
    """Sync presence lifecycle helpers."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def mark_online(self) -> None:
        self.heartbeat()

    def heartbeat(self) -> None:
        self._client.post("/v1/agents/heartbeat", {})

    def mark_offline(self) -> None:
        self._client.post("/v1/agents/disconnect", {})

    def disconnect(self) -> None:
        self.mark_offline()


# ── Main AgentClient ──────────────────────────────────────────────


class AgentClient:
    """Synchronous agent client for messaging, channels, DMs, files, etc."""

    def __init__(self, client: HttpClient) -> None:
        self.client = client
        self.dms = _DmsNamespace(client)
        self.channels = _ChannelsNamespace(client)
        self.actions = _ActionsNamespace(client)
        self.files = _FilesNamespace(client)
        self.presence = _PresenceNamespace(client)

    def me(self) -> Agent:
        result = self.client.get("/v1/agent")
        return Agent.model_validate(result)

    # ── Messages ──

    def send(
        self,
        channel: str,
        text: str,
        *,
        attachments: list[str] | None = None,
        mode: Literal["wait", "steer"] = "wait",
    ) -> MessageWithMeta:
        name = _strip_hash(channel)
        body: dict[str, Any] = {"text": text, "mode": mode}
        if attachments:
            body["attachments"] = attachments
        result = self.client.post(f"/v1/channels/{_enc(name)}/messages", body)
        return MessageWithMeta.model_validate(result)

    def post(
        self,
        channel: str,
        text: str,
        *,
        attachments: list[str] | None = None,
        mode: Literal["wait", "steer"] = "wait",
    ) -> MessageWithMeta:
        return self.send(channel, text, attachments=attachments, mode=mode)

    def messages(
        self,
        channel: str,
        *,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[MessageWithMeta]:
        name = _strip_hash(channel)
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        if before:
            query["before"] = before
        if after:
            query["after"] = after
        result = self.client.get(f"/v1/channels/{_enc(name)}/messages", query or None)
        return [MessageWithMeta.model_validate(m) for m in result]

    def message(self, id: str) -> MessageWithMeta:
        result = self.client.get(f"/v1/messages/{_enc(id)}")
        return MessageWithMeta.model_validate(result)

    def reply(self, id: str, text: str) -> MessageWithMeta:
        result = self.client.post(f"/v1/messages/{_enc(id)}/replies", {"text": text})
        return MessageWithMeta.model_validate(result)

    def thread(
        self,
        id: str,
        *,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> ThreadResponse:
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        if before:
            query["before"] = before
        if after:
            query["after"] = after
        result = self.client.get(f"/v1/messages/{_enc(id)}/replies", query or None)
        return ThreadResponse.model_validate(result)

    # ── DMs ──

    def dm(
        self,
        agent: str,
        text: str,
        mode: MessageInjectionMode = "wait",
        attachments: list[str] | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"to": agent, "text": text, "mode": mode}
        if attachments:
            payload["attachments"] = attachments
        return self.client.post("/v1/dm", payload)

    # ── Reactions ──

    def react(self, message_id: str, emoji: str) -> Any:
        return self.client.post(f"/v1/messages/{_enc(message_id)}/reactions", {"emoji": emoji})

    def unreact(self, message_id: str, emoji: str) -> None:
        self.client.delete(f"/v1/messages/{_enc(message_id)}/reactions/{_enc(emoji)}")

    def reactions(self, message_id: str) -> list[ReactionGroup]:
        result = self.client.get(f"/v1/messages/{_enc(message_id)}/reactions")
        return [ReactionGroup.model_validate(r) for r in result]

    # ── Search ──

    def search(
        self,
        query: str,
        *,
        channel: str | None = None,
        from_: str | None = None,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[Any]:
        params: dict[str, str] = {"q": query}
        if channel:
            params["channel"] = channel
        if from_:
            params["from"] = from_
        if limit:
            params["limit"] = str(limit)
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        return self.client.get("/v1/search", params)

    # ── Inbox ──

    def inbox(self, *, limit: int | None = None) -> InboxResponse:
        query: dict[str, str] = {}
        if limit is not None:
            query["limit"] = str(limit)
        result = self.client.get("/v1/inbox", query or None)
        return InboxResponse.model_validate(result)

    # ── Presence ──

    def mark_online(self) -> None:
        self.presence.mark_online()

    def heartbeat(self) -> None:
        self.presence.heartbeat()

    def mark_offline(self) -> None:
        self.presence.mark_offline()

    def disconnect(self) -> None:
        self.presence.disconnect()

    # ── Read Receipts ──

    def mark_read(self, message_id: str) -> Any:
        return self.client.post(f"/v1/messages/{_enc(message_id)}/read")

    def readers(self, message_id: str) -> list[ReaderInfo]:
        result = self.client.get(f"/v1/messages/{_enc(message_id)}/readers")
        return [ReaderInfo.model_validate(r) for r in result]

    def read_status(self, channel: str) -> list[ChannelReadStatus]:
        name = _strip_hash(channel)
        result = self.client.get(f"/v1/channels/{_enc(name)}/read-status")
        return [ChannelReadStatus.model_validate(r) for r in result]

    # ── Durable Delivery ──

    def deliveries(self, *, status: DeliveryStatus | None = None, limit: int | None = None) -> list[DeliveryItem]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = str(limit)
        result = self.client.get("/v1/deliveries", query or None)
        return [DeliveryItem.model_validate(d) for d in result]

    def ack_delivery(self, delivery_id: str) -> Delivery:
        result = self.client.post(f"/v1/deliveries/{_enc(delivery_id)}/ack", {})
        return Delivery.model_validate(result)

    def fail_delivery(self, delivery_id: str, options: FailDeliveryRequest | None = None) -> Delivery:
        body = options.model_dump(exclude_none=True) if options else {}
        result = self.client.post(f"/v1/deliveries/{_enc(delivery_id)}/fail", body)
        return Delivery.model_validate(result)

    def defer_delivery(self, delivery_id: str, options: DeferDeliveryRequest) -> Delivery:
        result = self.client.post(f"/v1/deliveries/{_enc(delivery_id)}/defer", options.model_dump(exclude_none=True))
        return Delivery.model_validate(result)


# ── Async variants ────────────────────────────────────────────────


class _AsyncDmsNamespace:
    """Async DM sub-operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def conversations(self) -> list[DmConversationSummary]:
        result = await self._client.get("/v1/dm/conversations")
        return [DmConversationSummary.model_validate(r) for r in result]

    async def messages(
        self,
        conversation_id: str,
        *,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[MessageWithMeta]:
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        if before:
            query["before"] = before
        if after:
            query["after"] = after
        result = await self._client.get(
            f"/v1/dm/{_enc(conversation_id)}/messages", query or None
        )
        return [MessageWithMeta.model_validate(m) for m in result]

    async def create_group(self, participants: list[str], text: str, *, name: str | None = None) -> Any:
        data = CreateGroupDmRequest(participants=participants, text=text, name=name)
        return await self._client.post("/v1/dm/group", data.model_dump(exclude_none=True))

    async def send_message(
        self,
        conversation_id: str,
        text: str,
        *,
        mode: MessageInjectionMode = "wait",
        attachments: list[str] | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"text": text, "mode": mode}
        if attachments:
            payload["attachments"] = attachments
        return await self._client.post(
            f"/v1/dm/{_enc(conversation_id)}/messages", payload
        )

    async def add_participant(self, conversation_id: str, agent: str) -> Any:
        return await self._client.post(
            f"/v1/dm/{_enc(conversation_id)}/participants", {"agent": agent}
        )

    async def remove_participant(self, conversation_id: str, agent: str) -> None:
        await self._client.delete(
            f"/v1/dm/{_enc(conversation_id)}/participants/{_enc(agent)}"
        )


class _AsyncChannelsNamespace:
    """Async channel sub-operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def create(self, name: str, *, topic: str | None = None) -> Channel:
        data = CreateChannelRequest(name=name, topic=topic)
        result = await self._client.post("/v1/channels", data.model_dump(exclude_none=True))
        return Channel.model_validate(result)

    async def list(self, *, include_archived: bool = False) -> list[Channel]:
        query: dict[str, str] = {}
        if include_archived:
            query["include_archived"] = "true"
        result = await self._client.get("/v1/channels", query or None)
        return [Channel.model_validate(c) for c in result]

    async def get(self, name: str) -> dict[str, Any]:
        return await self._client.get(f"/v1/channels/{_enc(name)}")

    async def join(self, name: str) -> Any:
        return await self._client.post(f"/v1/channels/{_enc(name)}/join")

    async def leave(self, name: str) -> None:
        await self._client.post(f"/v1/channels/{_enc(name)}/leave")

    async def set_topic(self, name: str, topic: str) -> Channel:
        result = await self._client.patch(f"/v1/channels/{_enc(name)}", {"topic": topic})
        return Channel.model_validate(result)

    async def archive(self, name: str) -> None:
        await self._client.delete(f"/v1/channels/{_enc(name)}")

    async def invite(self, channel: str, agent: str) -> Any:
        return await self._client.post(f"/v1/channels/{_enc(channel)}/invite", {"agent": agent})

    async def members(self, name: str) -> list[ChannelMemberInfo]:
        result = await self._client.get(f"/v1/channels/{_enc(name)}/members")
        return [ChannelMemberInfo.model_validate(m) for m in result]

    async def update(self, name: str, *, topic: str | None = None, metadata: dict[str, Any] | None = None) -> Channel:
        body: dict[str, Any] = {}
        if topic is not None:
            body["topic"] = topic
        if metadata is not None:
            body["metadata"] = metadata
        result = await self._client.patch(f"/v1/channels/{_enc(name)}", body)
        return Channel.model_validate(result)

    async def mute(self, name: str) -> None:
        await self._client.post(f"/v1/channels/{_enc(name)}/mute", {})

    async def unmute(self, name: str) -> None:
        await self._client.post(f"/v1/channels/{_enc(name)}/unmute", {})


class _AsyncActionsNamespace:
    """Async action invocation sub-operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def invoke(self, name: str, input: dict[str, Any] | None = None) -> Any:
        return await self._client.post(f"/v1/actions/{_enc(name)}/invoke", {"input": input})

    async def complete_invocation(self, name: str, invocation_id: str, data: dict[str, Any]) -> Any:
        return await self._client.post(
            f"/v1/actions/{_enc(name)}/invocations/{_enc(invocation_id)}/complete",
            data,
        )

    async def get_invocation(self, name: str, invocation_id: str) -> Any:
        return await self._client.get(f"/v1/actions/{_enc(name)}/invocations/{_enc(invocation_id)}")


class _AsyncFilesNamespace:
    """Async file sub-operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def upload(self, filename: str, content_type: str, size: int) -> UploadResponse:
        data = UploadRequest(filename=filename, content_type=content_type, size=size)
        result = await self._client.post("/v1/files/upload", data.model_dump())
        return UploadResponse.model_validate(result)

    async def complete(self, file_id: str) -> FileInfo:
        result = await self._client.post(f"/v1/files/{_enc(file_id)}/complete")
        return FileInfo.model_validate(result)

    async def get(self, file_id: str) -> FileInfo:
        result = await self._client.get(f"/v1/files/{_enc(file_id)}")
        return FileInfo.model_validate(result)

    async def delete(self, file_id: str) -> None:
        await self._client.delete(f"/v1/files/{_enc(file_id)}")

    async def list(self, *, uploaded_by: str | None = None, limit: int | None = None) -> list[FileInfo]:
        query: dict[str, str] = {}
        if uploaded_by:
            query["uploaded_by"] = uploaded_by
        if limit:
            query["limit"] = str(limit)
        result = await self._client.get("/v1/files", query or None)
        return [FileInfo.model_validate(f) for f in result]


class _AsyncPresenceNamespace:
    """Async presence lifecycle helpers."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def mark_online(self) -> None:
        await self.heartbeat()

    async def heartbeat(self) -> None:
        await self._client.post("/v1/agents/heartbeat", {})

    async def mark_offline(self) -> None:
        await self._client.post("/v1/agents/disconnect", {})

    async def disconnect(self) -> None:
        await self.mark_offline()


class AsyncAgentClient:
    """Asynchronous agent client for messaging, channels, DMs, files, etc."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self.client = client
        self.dms = _AsyncDmsNamespace(client)
        self.channels = _AsyncChannelsNamespace(client)
        self.actions = _AsyncActionsNamespace(client)
        self.files = _AsyncFilesNamespace(client)
        self.presence = _AsyncPresenceNamespace(client)

    async def me(self) -> Agent:
        result = await self.client.get("/v1/agent")
        return Agent.model_validate(result)

    # ── Messages ──

    async def send(
        self,
        channel: str,
        text: str,
        *,
        attachments: list[str] | None = None,
        mode: Literal["wait", "steer"] = "wait",
    ) -> MessageWithMeta:
        name = _strip_hash(channel)
        body: dict[str, Any] = {"text": text, "mode": mode}
        if attachments:
            body["attachments"] = attachments
        result = await self.client.post(f"/v1/channels/{_enc(name)}/messages", body)
        return MessageWithMeta.model_validate(result)

    async def post(
        self,
        channel: str,
        text: str,
        *,
        attachments: list[str] | None = None,
        mode: Literal["wait", "steer"] = "wait",
    ) -> MessageWithMeta:
        return await self.send(channel, text, attachments=attachments, mode=mode)

    async def messages(
        self,
        channel: str,
        *,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[MessageWithMeta]:
        name = _strip_hash(channel)
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        if before:
            query["before"] = before
        if after:
            query["after"] = after
        result = await self.client.get(f"/v1/channels/{_enc(name)}/messages", query or None)
        return [MessageWithMeta.model_validate(m) for m in result]

    async def message(self, id: str) -> MessageWithMeta:
        result = await self.client.get(f"/v1/messages/{_enc(id)}")
        return MessageWithMeta.model_validate(result)

    async def reply(self, id: str, text: str) -> MessageWithMeta:
        result = await self.client.post(f"/v1/messages/{_enc(id)}/replies", {"text": text})
        return MessageWithMeta.model_validate(result)

    async def thread(
        self,
        id: str,
        *,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> ThreadResponse:
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        if before:
            query["before"] = before
        if after:
            query["after"] = after
        result = await self.client.get(f"/v1/messages/{_enc(id)}/replies", query or None)
        return ThreadResponse.model_validate(result)

    # ── DMs ──

    async def dm(
        self,
        agent: str,
        text: str,
        mode: MessageInjectionMode = "wait",
        attachments: list[str] | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"to": agent, "text": text, "mode": mode}
        if attachments:
            payload["attachments"] = attachments
        return await self.client.post("/v1/dm", payload)

    # ── Reactions ──

    async def react(self, message_id: str, emoji: str) -> Any:
        return await self.client.post(f"/v1/messages/{_enc(message_id)}/reactions", {"emoji": emoji})

    async def unreact(self, message_id: str, emoji: str) -> None:
        await self.client.delete(f"/v1/messages/{_enc(message_id)}/reactions/{_enc(emoji)}")

    async def reactions(self, message_id: str) -> list[ReactionGroup]:
        result = await self.client.get(f"/v1/messages/{_enc(message_id)}/reactions")
        return [ReactionGroup.model_validate(r) for r in result]

    # ── Search ──

    async def search(
        self,
        query: str,
        *,
        channel: str | None = None,
        from_: str | None = None,
        limit: int | None = None,
        before: str | None = None,
        after: str | None = None,
    ) -> list[Any]:
        params: dict[str, str] = {"q": query}
        if channel:
            params["channel"] = channel
        if from_:
            params["from"] = from_
        if limit:
            params["limit"] = str(limit)
        if before:
            params["before"] = before
        if after:
            params["after"] = after
        return await self.client.get("/v1/search", params)

    # ── Inbox ──

    async def inbox(self, *, limit: int | None = None) -> InboxResponse:
        query: dict[str, str] = {}
        if limit is not None:
            query["limit"] = str(limit)
        result = await self.client.get("/v1/inbox", query or None)
        return InboxResponse.model_validate(result)

    # ── Presence ──

    async def mark_online(self) -> None:
        await self.presence.mark_online()

    async def heartbeat(self) -> None:
        await self.presence.heartbeat()

    async def mark_offline(self) -> None:
        await self.presence.mark_offline()

    async def disconnect(self) -> None:
        await self.presence.disconnect()

    # ── Read Receipts ──

    async def mark_read(self, message_id: str) -> Any:
        return await self.client.post(f"/v1/messages/{_enc(message_id)}/read")

    async def readers(self, message_id: str) -> list[ReaderInfo]:
        result = await self.client.get(f"/v1/messages/{_enc(message_id)}/readers")
        return [ReaderInfo.model_validate(r) for r in result]

    async def read_status(self, channel: str) -> list[ChannelReadStatus]:
        name = _strip_hash(channel)
        result = await self.client.get(f"/v1/channels/{_enc(name)}/read-status")
        return [ChannelReadStatus.model_validate(r) for r in result]

    # ── Durable Delivery ──

    async def deliveries(self, *, status: DeliveryStatus | None = None, limit: int | None = None) -> list[DeliveryItem]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = str(limit)
        result = await self.client.get("/v1/deliveries", query or None)
        return [DeliveryItem.model_validate(d) for d in result]

    async def ack_delivery(self, delivery_id: str) -> Delivery:
        result = await self.client.post(f"/v1/deliveries/{_enc(delivery_id)}/ack", {})
        return Delivery.model_validate(result)

    async def fail_delivery(self, delivery_id: str, options: FailDeliveryRequest | None = None) -> Delivery:
        body = options.model_dump(exclude_none=True) if options else {}
        result = await self.client.post(f"/v1/deliveries/{_enc(delivery_id)}/fail", body)
        return Delivery.model_validate(result)

    async def defer_delivery(self, delivery_id: str, options: DeferDeliveryRequest) -> Delivery:
        result = await self.client.post(f"/v1/deliveries/{_enc(delivery_id)}/defer", options.model_dump(exclude_none=True))
        return Delivery.model_validate(result)
