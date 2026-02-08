"""WebSocket client for real-time Relay events."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable
from urllib.parse import quote

import websockets
from websockets.asyncio.client import ClientConnection

logger = logging.getLogger(__name__)

EventHandler = Callable[[dict[str, Any]], None]

_MAX_RECONNECT_ATTEMPTS = 10
_PING_INTERVAL_SECONDS = 30


class WsClient:
    """Async WebSocket client with auto-reconnection and event handling.

    Usage::

        ws = WsClient(token="at_xxx")
        ws.on("message.created", lambda e: print(e))
        ws.subscribe(["general", "code-review"])
        await ws.connect()  # blocks until disconnect() is called
    """

    def __init__(self, token: str, *, base_url: str | None = None) -> None:
        self._token = token
        base = (base_url or "https://api.agentrelay.dev").rstrip("/")
        self._base_url = base.replace("https://", "wss://").replace("http://", "ws://")
        self._ws: ClientConnection | None = None
        self._handlers: dict[str, set[EventHandler]] = {}
        self._reconnect_attempt = 0
        self._closed = False
        self._ping_task: asyncio.Task[None] | None = None
        self._pending_subscriptions: list[str] = []

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
        url = f"{self._base_url}/v1/stream?token={quote(self._token, safe='')}"
        async with websockets.connect(url) as ws:
            self._ws = ws
            self._reconnect_attempt = 0
            self._start_ping()
            self._emit("open", {"type": "open"})

            # Re-subscribe to any pending channels
            if self._pending_subscriptions:
                await self._send_json({"type": "subscribe", "channels": self._pending_subscriptions})

            try:
                async for raw in ws:
                    try:
                        data = json.loads(raw)
                        self._emit(data.get("type", ""), data)
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

    def _start_ping(self) -> None:
        self._stop_ping()
        self._ping_task = asyncio.ensure_future(self._ping_loop())

    def _stop_ping(self) -> None:
        if self._ping_task:
            self._ping_task.cancel()
            self._ping_task = None

    async def _ping_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(_PING_INTERVAL_SECONDS)
                await self._send_json({"type": "ping"})
        except asyncio.CancelledError:
            pass
