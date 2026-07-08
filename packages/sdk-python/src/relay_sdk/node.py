"""Node provider client — attaches a process to a node's capabilities.

A node provider connects to the engine's ``/v1/node/ws``, registers a subset
of a node's capabilities, and executes their invokes. It is the language-
neutral equivalent of the broker's Rust provider — connection, registration,
heartbeats, invoke dispatch, and the handler-context helpers — with no local-
broker dependency.

Enrollment (reading the node token/URL from disk) layers on top of this in a
thin wrapper; the client itself takes an explicit token and base URL.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Protocol
from urllib.parse import quote

import websockets
from websockets.asyncio.client import ClientConnection

from .client import SDK_VERSION

logger = logging.getLogger(__name__)

_DEFAULT_BASE_URL = "https://cast.agentrelay.com"
_ORIGIN_CLIENT = "@relaycast/python-sdk"


def _random_id() -> str:
    return str(uuid.uuid4())


class NodeProviderError(Exception):
    """Raised for provider-client-level failures (transport, lifecycle)."""


class NodeRegistrationError(Exception):
    """Raised when the engine rejects the provider's registration, or when
    an ``error`` frame answers any id-keyed request (register, spawn, message).
    """

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class NodeConnectionClosed(Exception):
    """Raised by a `NodeConnection.recv()` implementation when the
    underlying transport has closed."""


class NodeConnection(Protocol):
    """The minimal transport surface the provider client needs. Tests supply
    a fake implementation; the default wraps `websockets.connect`."""

    async def send(self, data: str) -> None: ...

    async def recv(self) -> str: ...

    async def close(self) -> None: ...


NodeConnectFactory = Callable[[str], Awaitable[NodeConnection]]


class _WebsocketConnection:
    """Adapts a real `websockets` client connection to `NodeConnection`."""

    def __init__(self, ws: ClientConnection) -> None:
        self._ws = ws

    async def send(self, data: str) -> None:
        await self._ws.send(data)

    async def recv(self) -> str:
        try:
            message = await self._ws.recv()
        except websockets.exceptions.ConnectionClosed as exc:
            raise NodeConnectionClosed(str(exc)) from exc
        if isinstance(message, bytes):
            return message.decode("utf-8")
        return message

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await self._ws.close()


async def _default_connect(url: str) -> NodeConnection:
    ws = await websockets.connect(url)
    return _WebsocketConnection(ws)


@dataclass(frozen=True)
class NodeCapabilityOptions:
    """A capability's declaration alongside its handler.

    `kind` is 'action' (materializes an invokable handler) or 'capacity'
    (describes what the node can run and is never materialized); omit to let
    the engine classify by name. `global_` claims a workspace-global alias
    for this action name (wire field `global`). `queue` queues invokes while
    this provider is offline instead of failing fast.
    """

    kind: Literal["action", "capacity"] | None = None
    global_: bool = False
    queue: bool = False
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class NodeInfo:
    """Informational view of the node a provider is attached to."""

    name: str
    capabilities: list[str]


@dataclass
class _RegisteredCapability:
    options: NodeCapabilityOptions
    handler: "NodeCapabilityHandler"


NodeCapabilityHandler = Callable[[Any, "NodeHandlerContext"], Awaitable[Any]]
NodeCapabilitySpec = NodeCapabilityHandler | Mapping[str, Any]


class NodeHandlerContext:
    """Context passed to every capability handler."""

    def __init__(self, provider: "NodeProvider", invocation_id: str) -> None:
        self._provider = provider
        self.invocation_id = invocation_id
        self.node = NodeInfo(name=provider._node_name, capabilities=list(provider._handlers.keys()))

    async def send_message(
        self,
        *,
        to: str,
        from_: str,
        text: str,
        thread_id: str | None = None,
        mode: Literal["wait", "steer"] | None = None,
        data: dict[str, Any] | None = None,
    ) -> Any:
        """Post a channel message, attributed to `from_` (an agent name
        resolved in the workspace). Resolves with the posted message."""
        frame: dict[str, Any] = {"type": "node.message", "to": to, "from": from_, "text": text}
        if thread_id is not None:
            frame["thread_id"] = thread_id
        if mode is not None:
            frame["mode"] = mode
        if data is not None:
            frame["data"] = data
        return await self._provider._request(_random_id(), frame)

    async def spawn_agent(self, input: Any) -> Any:
        """Spawn an agent through the node's capacity executor.

        Capacity-direct: it never re-enters action dispatch, so a
        `spawn:<harness>` shadow handler that delegates cannot recurse into
        itself. Resolves with the spawn placement."""
        frame = {"type": "node.spawn", "input": input, "target_node_id": self._provider._node_id}
        return await self._provider._request(_random_id(), frame)


class NodeProvider:
    """A node provider client: connects to a node's `/v1/node/ws`, registers
    a subset of its capabilities, and dispatches their invokes.

    Constructor takes explicit values — no enrollment-file logic; that is a
    later, relay-side step layered on top of this client.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        node_token: str,
        node_id: str,
        node_name: str,
        provider: Mapping[str, Any],
        capabilities: Mapping[str, NodeCapabilitySpec] | None = None,
        max_agents: int = 0,
        tags: list[str] | None = None,
        version: str | None = None,
        machine_id: str | None = None,
        heartbeat_interval: float = 15.0,
        reconnect_base_delay: float = 0.5,
        reconnect_max_delay: float = 30.0,
        reconnect_jitter: bool = True,
        max_reconnect_attempts: int | None = None,
        on_error: Callable[[Exception], None] | None = None,
        connect: NodeConnectFactory | None = None,
    ) -> None:
        base = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self._ws_base_url = base.replace("https://", "wss://").replace("http://", "ws://")
        self._node_token = node_token
        self._node_id = node_id
        self._node_name = node_name
        self._provider_name = provider["name"]
        self._initial_instance_id: str | None = provider.get("instance_id")
        self._max_agents = max_agents
        self._tags = list(tags) if tags else []
        self._version = version or SDK_VERSION
        self._machine_id = machine_id
        self._heartbeat_interval = heartbeat_interval
        self._reconnect_base_delay = reconnect_base_delay
        self._reconnect_max_delay = reconnect_max_delay
        self._reconnect_jitter = reconnect_jitter
        self._max_reconnect_attempts = max_reconnect_attempts
        self._on_error = on_error
        self._connect_factory: NodeConnectFactory = connect or _default_connect

        self._handlers: dict[str, _RegisteredCapability] = {}
        self._pending: dict[str, asyncio.Future[Any]] = {}
        self._invoke_tasks: set[asyncio.Task[None]] = set()

        self._conn: NodeConnection | None = None
        self._instance_id: str | None = None
        self._registered = False
        self._stopped = True
        self._serving = False
        self._reconnect_attempt = 0
        self._reconnect_sleep_task: asyncio.Task[None] | None = None

        self._register_future: asyncio.Future[dict[str, Any]] | None = None
        self._register_result: dict[str, Any] | None = None
        self._register_error: Exception | None = None

        for name, spec in (capabilities or {}).items():
            self._register_capability_spec(name, spec)

    # ── Capability registration ──────────────────────────────────

    def capability(
        self,
        name: str,
        handler: NodeCapabilityHandler | None = None,
        *,
        kind: Literal["action", "capacity"] | None = None,
        global_: bool = False,
        queue: bool = False,
        metadata: dict[str, Any] | None = None,
    ) -> Any:
        """Register a capability and its handler.

        Usable as a decorator (`@node.capability("run-etl")`) when `handler`
        is omitted, or as a direct call (`node.capability("run-etl", fn)`).
        """
        options = NodeCapabilityOptions(kind=kind, global_=global_, queue=queue, metadata=metadata)

        def register(fn: NodeCapabilityHandler) -> NodeCapabilityHandler:
            self._handlers[name] = _RegisteredCapability(options=options, handler=fn)
            return fn

        if handler is not None:
            register(handler)
            return self
        return register

    def _register_capability_spec(self, name: str, spec: NodeCapabilitySpec) -> None:
        if callable(spec):
            self.capability(name, spec)
            return
        if isinstance(spec, Mapping):
            opts = dict(spec)
            handler = opts.pop("handler", None)
            if handler is None or not callable(handler):
                raise ValueError(f'capability "{name}" requires a handler')
            self.capability(
                name,
                handler,
                kind=opts.pop("kind", None),
                global_=bool(opts.pop("global", False)),
                queue=bool(opts.pop("queue", False)),
                metadata=opts.pop("metadata", None),
            )
            return
        raise TypeError(f'capability "{name}" must be a handler function or a mapping with "handler"')

    # ── Public lifecycle ─────────────────────────────────────────

    @property
    def connected(self) -> bool:
        return self._registered and self._conn is not None

    async def wait_registered(self) -> dict[str, Any]:
        """Resolve once the provider is registered and its capabilities are
        accepted. Raises if registration is hard-rejected."""
        if self._register_error is not None:
            raise self._register_error
        if self._register_result is not None:
            return self._register_result
        if self._register_future is None:
            self._register_future = asyncio.get_running_loop().create_future()
        return await self._register_future

    async def serve(self) -> None:
        """Connect, register, and dispatch invokes until `stop()` is called.

        Reconnects with backoff on unexpected drops, re-registering with a
        fresh instance id each time. Raises if the initial registration is
        rejected by the engine.
        """
        if self._serving:
            raise NodeProviderError("serve() is already running")
        self._serving = True
        self._stopped = False
        self._reconnect_attempt = 0
        try:
            while not self._stopped:
                try:
                    await self._run_connection()
                except NodeRegistrationError as exc:
                    self._reject_registered(exc)
                    self._report_error(exc)
                    self._stopped = True
                    raise
                if self._stopped:
                    break
                await self._backoff_sleep()
        finally:
            self._serving = False

    async def stop(self) -> None:
        """Gracefully deregister the provider and close the connection."""
        self._stopped = True
        if self._reconnect_sleep_task is not None:
            self._reconnect_sleep_task.cancel()
        conn = self._conn
        if conn is not None and self._registered and self._instance_id:
            await self._send_frame({"type": "node.deregister", "provider": self._provider_identity()})
        self._reject_pending(NodeProviderError("node provider stopped"))
        if conn is not None:
            await self._safe_close(conn)
        self._registered = False

    # ── Connection lifecycle ─────────────────────────────────────

    async def _run_connection(self) -> None:
        self._instance_id = (
            self._initial_instance_id
            if self._reconnect_attempt == 0 and self._initial_instance_id
            else _random_id()
        )
        self._registered = False
        url = self._build_url()
        try:
            conn = await self._connect_factory(url)
        except Exception as exc:  # connect failure: report and retry
            self._report_error(exc)
            return
        self._conn = conn

        reader_task = asyncio.create_task(self._reader_loop(conn))
        try:
            await self._send_register()
        except NodeRegistrationError:
            await self._cancel_task(reader_task)
            await self._safe_close(conn)
            if self._conn is conn:
                self._conn = None
            raise
        except Exception as exc:  # transport failure while registering: retry
            self._report_error(exc)
            await self._cancel_task(reader_task)
            await self._safe_close(conn)
            if self._conn is conn:
                self._conn = None
            return

        heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        try:
            await reader_task
        finally:
            await self._cancel_task(heartbeat_task)
            self._registered = False
            self._reject_pending(NodeProviderError("node provider connection closed"))
            await self._safe_close(conn)
            if self._conn is conn:
                self._conn = None

    async def _reader_loop(self, conn: NodeConnection) -> None:
        while True:
            try:
                raw = await conn.recv()
            except NodeConnectionClosed:
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._report_error(exc)
                return
            await self._handle_frame(raw)
            if self._stopped:
                return

    async def _backoff_sleep(self) -> None:
        if self._max_reconnect_attempts is not None and self._reconnect_attempt >= self._max_reconnect_attempts:
            self._report_error(NodeProviderError("node provider exhausted reconnect attempts"))
            self._stopped = True
            return
        self._reconnect_attempt += 1
        exp = min(self._reconnect_base_delay * (2 ** (self._reconnect_attempt - 1)), self._reconnect_max_delay)
        delay = exp * (0.5 + random.random()) if self._reconnect_jitter else exp
        self._reconnect_sleep_task = asyncio.ensure_future(asyncio.sleep(delay))
        try:
            await self._reconnect_sleep_task
        except asyncio.CancelledError:
            pass
        finally:
            self._reconnect_sleep_task = None

    @staticmethod
    async def _cancel_task(task: asyncio.Task[Any]) -> None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _safe_close(self, conn: NodeConnection) -> None:
        with contextlib.suppress(Exception):
            await conn.close()

    # ── Registration ─────────────────────────────────────────────

    async def _send_register(self) -> None:
        req_id = _random_id()
        capabilities: list[dict[str, Any]] = []
        for name, cap in self._handlers.items():
            entry: dict[str, Any] = {"name": name}
            if cap.options.kind:
                entry["kind"] = cap.options.kind
            if cap.options.global_:
                entry["global"] = True
            if cap.options.queue:
                entry["queue"] = True
            if cap.options.metadata:
                entry["metadata"] = cap.options.metadata
            capabilities.append(entry)

        frame: dict[str, Any] = {
            "type": "node.register",
            "name": self._node_name,
            "node_id": self._node_id,
            "provider": self._provider_identity(),
            "capabilities": capabilities,
            "max_agents": self._max_agents,
            "tags": self._tags,
            "version": self._version,
            "resume_cursor": None,
        }
        if self._machine_id:
            frame["machine_id"] = self._machine_id

        data = await self._request(req_id, frame)
        accepted = (data or {}).get("accepted_capabilities") or []
        rejected = [c for c in accepted if not c.get("accepted")]
        if rejected:
            detail = ", ".join(
                f"{c.get('name')}" + (f" ({c['reason']})" if c.get("reason") else "") for c in rejected
            )
            raise NodeRegistrationError(f"Capabilities rejected: {detail}", "capabilities_rejected")

        self._registered = True
        self._reconnect_attempt = 0
        self._resolve_registered(data or {})

    def _resolve_registered(self, data: dict[str, Any]) -> None:
        self._register_result = data
        if self._register_future is not None and not self._register_future.done():
            self._register_future.set_result(data)

    def _reject_registered(self, err: Exception) -> None:
        self._register_error = err
        if self._register_future is not None and not self._register_future.done():
            self._register_future.set_exception(err)

    def _provider_identity(self) -> dict[str, str]:
        return {"name": self._provider_name, "instance_id": self._instance_id or ""}

    # ── Frame handling ────────────────────────────────────────────

    async def _handle_frame(self, raw: str) -> None:
        try:
            message = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return
        if not isinstance(message, dict):
            return
        msg_type = message.get("type")
        if msg_type == "reply":
            fut = self._pending.pop(message.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(message.get("data"))
            return
        if msg_type == "error":
            fut = self._pending.pop(message.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_exception(
                    NodeRegistrationError(message.get("message", "error"), message.get("code", "error"))
                )
            return
        if msg_type == "action.invoke":
            invocation_id = message.get("invocation_id", "")
            action = message.get("action", "")
            input_ = message.get("input")
            task = asyncio.create_task(self._dispatch_invoke(invocation_id, action, input_))
            self._invoke_tasks.add(task)
            task.add_done_callback(self._invoke_tasks.discard)
            return
        # deliver / context.update / ping carry no work for a provider client.
        return

    async def _dispatch_invoke(self, invocation_id: str, action: str, input_: Any) -> None:
        cap = self._handlers.get(action)
        if cap is None:
            await self._send_frame(
                {
                    "type": "action.result",
                    "invocation_id": invocation_id,
                    "error": f'No handler registered for action "{action}"',
                }
            )
            return
        ctx = NodeHandlerContext(self, invocation_id)
        try:
            output = await cap.handler(input_, ctx)
        except Exception as exc:  # a handler throw becomes an error result; never dropped
            await self._send_frame(
                {"type": "action.result", "invocation_id": invocation_id, "error": str(exc)}
            )
            return
        await self._send_frame({"type": "action.result", "invocation_id": invocation_id, "output": output})

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self._heartbeat_interval)
                await self._send_frame(
                    {
                        "type": "node.heartbeat",
                        "provider": self._provider_identity(),
                        "load": 0,
                        "active_agents": 0,
                        "handlers_live": True,
                    }
                )
        except asyncio.CancelledError:
            raise

    # ── Transport ─────────────────────────────────────────────────

    def _build_url(self) -> str:
        query = {
            "token": self._node_token,
            "origin_client": _ORIGIN_CLIENT,
            "origin_version": SDK_VERSION,
        }
        qs = "&".join(f"{k}={quote(v, safe='')}" for k, v in query.items())
        return f"{self._ws_base_url}/v1/node/ws?{qs}"

    async def _request(self, req_id: str, frame: dict[str, Any]) -> Any:
        conn = self._conn
        if conn is None:
            raise NodeProviderError("node provider websocket is not open")
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        payload = {"v": 1, "id": req_id, **frame}
        try:
            await conn.send(json.dumps(payload))
        except Exception:
            self._pending.pop(req_id, None)
            raise
        return await fut

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        conn = self._conn
        if conn is None:
            return
        try:
            await conn.send(json.dumps({"v": 1, **frame}))
        except Exception as exc:
            self._report_error(exc)

    def _reject_pending(self, err: Exception) -> None:
        pending = self._pending
        self._pending = {}
        for fut in pending.values():
            if not fut.done():
                fut.set_exception(err)

    def _report_error(self, err: BaseException) -> None:
        error = err if isinstance(err, Exception) else Exception(str(err))
        if self._on_error is not None:
            try:
                self._on_error(error)
            except Exception:
                logger.exception("node provider on_error handler raised")
        else:
            logger.warning("node provider error: %s", error)
