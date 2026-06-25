"""WebSocket client for real-time Relay events."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable
from urllib.parse import quote

import websockets
from websockets.asyncio.client import ClientConnection

from .client import (
    AGENT_RELAY_DISTINCT_ID_QUERY,
    AsyncHttpClient,
    SDK_VERSION,
    sanitize_agent_relay_distinct_id,
)

logger = logging.getLogger(__name__)

EventHandler = Callable[[dict[str, Any]], None]

_MAX_RECONNECT_ATTEMPTS = 10
_PING_INTERVAL_SECONDS = 30


class WsClient:
    """Async WebSocket client with auto-reconnection and event handling.

    Usage::

        ws = WsClient(token="ot_live_xxx")
        ws.on("message.created", lambda e: print(e))
        ws.subscribe(["general", "code-review"])
        await ws.connect()  # blocks until disconnect() is called
    """

    def __init__(
        self,
        token: str,
        *,
        base_url: str | None = None,
        path: str | None = None,
        node_registration: dict[str, Any] | None = None,
        auto_ack_deliveries: bool = False,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_distinct_id: str | None = None,
    ) -> None:
        self._token = token
        base = (base_url or "https://cast.agentrelay.com").rstrip("/")
        self._http_base_url = base
        self._base_url = base.replace("https://", "wss://").replace("http://", "ws://")
        self._path = path
        self._node_registration = node_registration
        self._auto_ack_deliveries = auto_ack_deliveries
        self._origin_client = (origin_client or "@relaycast/python-sdk").strip()[:80]
        self._origin_version = (origin_version or SDK_VERSION).strip()[:48]
        self._agent_relay_distinct_id = sanitize_agent_relay_distinct_id(agent_relay_distinct_id)
        self._ws: ClientConnection | None = None
        self._handlers: dict[str, set[EventHandler]] = {}
        self._reconnect_attempt = 0
        self._closed = False
        self._ping_task: asyncio.Task[None] | None = None
        self._pending_subscriptions: list[str] = []

    async def _resolve_agent_node_transport(self) -> tuple[str, str, dict[str, Any]]:
        client = AsyncHttpClient(
            self._token,
            self._http_base_url,
            origin_client=self._origin_client,
            origin_version=self._origin_version,
            agent_relay_distinct_id=self._agent_relay_distinct_id,
        )
        try:
            direct = await client.post("/v1/agent/node-token", {})
        finally:
            await client.close()

        node_id = str(direct["node_id"])
        node_name = str(direct["node_name"])
        return (
            str(direct["token"]),
            "/v1/node/ws",
            {
                "v": 1,
                "id": f"python-direct-{node_id}",
                "type": "node.register",
                "node_id": node_id,
                "name": node_name,
                "capabilities": [],
                "max_agents": 1,
                "tags": ["implicit", "direct", "sdk"],
                "version": f"python-sdk/{SDK_VERSION}",
                "resume_cursor": None,
            },
        )

    async def _transport(self) -> tuple[str, str, dict[str, Any] | None, bool]:
        if self._path is None and self._token.startswith("at_"):
            token, path, registration = await self._resolve_agent_node_transport()
            return token, path, registration, True
        if self._node_registration is not None:
            return self._token, self._path or "/v1/node/ws", self._node_registration, self._auto_ack_deliveries
        return self._token, self._path or "/v1/ws", None, self._auto_ack_deliveries

    async def connect(self) -> None:
        """Connect to the WebSocket and process events until disconnected."""
        self._closed = False
        while not self._closed:
            try:
                await self._connect_once()
            except Exception:
                if self._closed:
                    break
                if self._reconnect_attempt >= _MAX_RECONNECT_ATTEMPTS:
                    logger.error("Max reconnect attempts reached")
                    break
                delay = min(2**self._reconnect_attempt, 30)
                self._reconnect_attempt += 1
                logger.info("Reconnecting in %ds (attempt %d)", delay, self._reconnect_attempt)
                await asyncio.sleep(delay)

    async def _connect_once(self) -> None:
        token, path, node_registration, auto_ack_deliveries = await self._transport()
        url = (
            f"{self._base_url}{path}"
            f"?token={quote(token, safe='')}"
            f"&origin_client={quote(self._origin_client, safe='')}"
            f"&origin_version={quote(self._origin_version, safe='')}"
        )
        if self._agent_relay_distinct_id:
            url += (
                f"&{AGENT_RELAY_DISTINCT_ID_QUERY}="
                f"{quote(self._agent_relay_distinct_id, safe='')}"
            )
        async with websockets.connect(url) as ws:
            self._ws = ws
            self._reconnect_attempt = 0
            if node_registration is not None:
                await self._send_json(node_registration)
            self._start_ping(node_registration)
            self._emit("open", {"type": "open"})

            # Re-subscribe to any pending channels
            if self._pending_subscriptions:
                await self._send_json({"type": "subscribe", "channels": self._pending_subscriptions})

            try:
                async for raw in ws:
                    try:
                        data = json.loads(raw)
                        handled = await self._handle_node_frame(data, auto_ack_deliveries)
                        if handled:
                            continue
                        event_type = data.get("type", "")
                        if event_type == "ping":
                            await self._send_json({"type": "pong"})
                        self._emit(event_type, data)
                    except (json.JSONDecodeError, TypeError):
                        pass
            finally:
                self._stop_ping()
                self._ws = None
                self._emit("close", {"type": "close"})

    def disconnect(self) -> None:
        """Signal disconnect. The connect() loop will exit."""
        self._closed = True
        self._stop_ping()
        if self._ws:
            asyncio.ensure_future(self._ws.close())

    def subscribe(self, channels: list[str]) -> None:
        """Subscribe to channels. If not connected yet, subscribes on connect."""
        self._pending_subscriptions = list(set(self._pending_subscriptions + channels))
        if self._ws:
            asyncio.ensure_future(self._send_json({"type": "subscribe", "channels": channels}))

    def unsubscribe(self, channels: list[str]) -> None:
        """Unsubscribe from channels."""
        self._pending_subscriptions = [c for c in self._pending_subscriptions if c not in channels]
        if self._ws:
            asyncio.ensure_future(self._send_json({"type": "unsubscribe", "channels": channels}))

    async def send(self, frame: dict[str, Any]) -> None:
        """Send an arbitrary JSON frame over the socket.

        No-op if the client is not currently connected.
        """
        await self._send_json(frame)

    async def _handle_node_frame(self, data: Any, auto_ack_deliveries: bool) -> bool:
        if not isinstance(data, dict):
            return False
        if data.get("type") == "deliver":
            payload = data.get("payload")
            if isinstance(payload, dict):
                event_type = payload.get("type")
                event_data = payload.get("data")
                if isinstance(event_type, str) and isinstance(event_data, dict):
                    self._emit(event_type, _server_like_event(event_type, event_data))
            if auto_ack_deliveries and isinstance(data.get("agent"), str) and isinstance(data.get("seq"), int):
                await self._send_json({
                    "v": 1,
                    "type": "delivery.ack",
                    "agent": data["agent"],
                    "up_to_seq": data["seq"],
                })
            return True
        if data.get("type") == "context.update":
            event_type = data.get("event")
            event_data = data.get("data")
            if isinstance(event_type, str) and isinstance(event_data, dict):
                self._emit(event_type, _server_like_event(event_type, event_data))
            return True
        if data.get("type") == "action.invoke":
            self._emit("action.invoked", {
                "type": "action.invoked",
                "invocation_id": data.get("invocation_id", ""),
                "action_name": data.get("action", ""),
                "caller_name": "node",
                "handler_agent_id": data.get("agent_id", ""),
                "handler_agent_name": data.get("agent_name"),
                "input": data.get("input") if isinstance(data.get("input"), dict) else {},
            })
            return True
        return False

    def on(self, event: str, handler: EventHandler) -> Callable[[], None]:
        """Register an event handler. Returns an unsubscribe callable."""
        if event not in self._handlers:
            self._handlers[event] = set()
        self._handlers[event].add(handler)

        def remove() -> None:
            self._handlers.get(event, set()).discard(handler)

        return remove

    def off(self, event: str, handler: EventHandler) -> None:
        """Remove an event handler."""
        self._handlers.get(event, set()).discard(handler)

    def _emit(self, event: str, data: dict[str, Any]) -> None:
        for h in self._handlers.get(event, set()).copy():
            try:
                h(data)
            except Exception:
                logger.exception("Event handler error for %s", event)
        for h in self._handlers.get("*", set()).copy():
            try:
                h(data)
            except Exception:
                logger.exception("Wildcard handler error for %s", event)

    async def _send_json(self, data: Any) -> None:
        if self._ws:
            try:
                await self._ws.send(json.dumps(data))
            except Exception:
                pass

    def _start_ping(self, node_registration: dict[str, Any] | None = None) -> None:
        self._stop_ping()
        self._ping_task = asyncio.ensure_future(self._ping_loop(node_registration))

    def _stop_ping(self) -> None:
        if self._ping_task:
            self._ping_task.cancel()
            self._ping_task = None

    async def _ping_loop(self, node_registration: dict[str, Any] | None = None) -> None:
        try:
            while True:
                await asyncio.sleep(_PING_INTERVAL_SECONDS)
                if node_registration is not None:
                    await self._send_json({
                        "v": 1,
                        "type": "node.heartbeat",
                        "node_id": node_registration.get("node_id"),
                        "name": node_registration.get("name"),
                        "load": 0,
                        "active_agents": 1,
                        "handlers_live": False,
                    })
                else:
                    await self._send_json({"type": "ping"})
        except asyncio.CancelledError:
            pass


def _server_like_event(event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    if event_type == "message.created":
        return {
            "type": "message.created",
            "channel": data.get("channel_name"),
            "message": {
                "id": data.get("id"),
                "agent_id": data.get("agent_id"),
                "agent_name": data.get("from_name"),
                "text": data.get("text"),
                "attachments": data.get("attachments") if isinstance(data.get("attachments"), list) else [],
                **({"injection_mode": data["injection_mode"]} if isinstance(data.get("injection_mode"), str) else {}),
            },
        }
    if event_type == "thread.reply":
        return {
            "type": "thread.reply",
            "channel": data.get("channel_name"),
            "parent_id": data.get("thread_id"),
            "message": {
                "id": data.get("id"),
                "agent_id": data.get("agent_id"),
                "agent_name": data.get("from_name"),
                "text": data.get("text"),
            },
        }
    if event_type in {"dm.received", "group_dm.received"}:
        message = data.get("message") if isinstance(data.get("message"), dict) else {}
        attachments = message.get("attachments") if isinstance(message.get("attachments"), list) else data.get("attachments")
        return {
            "type": event_type,
            "conversation_id": data.get("conversation_id"),
            "message": {
                "id": message.get("id", data.get("id")),
                "agent_id": message.get("agent_id", data.get("agent_id")),
                "agent_name": message.get("agent_name", data.get("from_name")),
                "text": message.get("text", data.get("text")),
                **({"attachments": attachments} if isinstance(attachments, list) else {}),
            },
        }
    return {"type": event_type, **data}
