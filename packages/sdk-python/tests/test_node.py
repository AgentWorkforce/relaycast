"""Tests for NodeProvider — against an in-process fake node-ws server.

Never opens a real socket: the fake `connect` factory hands the client an
in-memory `FakeConnection` that the test drives directly (push frames in,
inspect frames sent out).
"""

from __future__ import annotations

import asyncio
import json

import pytest

from relay_sdk.node import NodeConnectionClosed, NodeProvider, NodeRegistrationError

BASE_URL = "https://engine.test"


class FakeConnection:
    """One fake node-ws connection: captures sent frames, lets the test
    push incoming frames, and raises on `recv()` once dropped/closed."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.sent: list[dict] = []
        self._incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    async def recv(self) -> str:
        item = await self._incoming.get()
        if item is None:
            raise NodeConnectionClosed("closed")
        return item

    async def close(self) -> None:
        self.closed = True
        self._incoming.put_nowait(None)

    def push(self, frame: dict) -> None:
        self._incoming.put_nowait(json.dumps(frame))

    def drop(self) -> None:
        """Simulate an unexpected disconnect (not a graceful close)."""
        self._incoming.put_nowait(None)

    def sent_of_type(self, type_: str) -> list[dict]:
        return [f for f in self.sent if f.get("type") == type_]

    def last_register(self) -> dict:
        return self.sent_of_type("node.register")[-1]


class FakeNodeServer:
    """Hands out `FakeConnection`s in connection order via an injectable
    `connect` factory, and lets the test await the next one deterministically."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[FakeConnection] = asyncio.Queue()

    async def connect(self, url: str) -> FakeConnection:
        conn = FakeConnection(url)
        await self._queue.put(conn)
        return conn

    async def next_connection(self) -> FakeConnection:
        return await asyncio.wait_for(self._queue.get(), timeout=1.0)


def accept_all(register: dict) -> dict:
    caps = register.get("capabilities") or []
    provider = register["provider"]
    return {
        "v": 1,
        "id": register["id"],
        "type": "reply",
        "ok": True,
        "data": {
            "provider": provider,
            "accepted_capabilities": [
                {"name": c["name"], "kind": c.get("kind", "action"), "accepted": True} for c in caps
            ],
            "name": register["name"],
        },
    }


def base_kwargs(server: FakeNodeServer, **overrides) -> dict:
    kwargs = dict(
        base_url=BASE_URL,
        node_token="nt_live_test",
        node_id="node_a",
        node_name="alpha",
        provider={"name": "py"},
        connect=server.connect,
        reconnect_jitter=False,
        reconnect_base_delay=0.01,
        reconnect_max_delay=0.05,
        heartbeat_interval=15.0,
    )
    kwargs.update(overrides)
    return kwargs


async def wait_until(predicate, timeout: float = 1.0, interval: float = 0.005) -> None:
    async def _poll():
        while not predicate():
            await asyncio.sleep(interval)

    await asyncio.wait_for(_poll(), timeout)


@pytest.mark.asyncio
async def test_connects_and_registers_with_accepted_capabilities():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))

    @node.capability("run-etl")
    async def handler(input, ctx):
        return "ok"

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    assert conn.url.startswith("wss://engine.test/v1/node/ws?")
    assert "token=nt_live_test" in conn.url

    register = conn.last_register()
    assert register["type"] == "node.register"
    assert register["name"] == "alpha"
    assert register["node_id"] == "node_a"
    assert register["provider"]["name"] == "py"
    assert register["provider"]["instance_id"]
    assert register["capabilities"] == [{"name": "run-etl"}]

    conn.push(accept_all(register))
    data = await node.wait_registered()
    assert data["name"] == "alpha"
    assert node.connected is True

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_registration_rejected_capability_raises():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))
    node.capability("run-etl", lambda input, ctx: "ok")

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    register = conn.last_register()
    conn.push(
        {
            "v": 1,
            "id": register["id"],
            "type": "reply",
            "ok": True,
            "data": {
                "provider": register["provider"],
                "accepted_capabilities": [
                    {"name": "run-etl", "kind": "action", "accepted": False, "reason": "duplicate action name"}
                ],
            },
        }
    )

    with pytest.raises(NodeRegistrationError, match="run-etl"):
        await node.wait_registered()

    with pytest.raises(NodeRegistrationError):
        await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_registration_rejected_by_error_frame_raises():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    register = conn.last_register()
    conn.push(
        {
            "v": 1,
            "id": register["id"],
            "type": "error",
            "ok": False,
            "code": "provider_instance_conflict",
            "message": "already connected",
        }
    )

    with pytest.raises(NodeRegistrationError) as exc_info:
        await node.wait_registered()
    assert exc_info.value.code == "provider_instance_conflict"

    with pytest.raises(NodeRegistrationError):
        await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_invoke_runs_handler_and_replies_with_output():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))

    @node.capability("run-etl")
    async def handler(input, ctx):
        return {"echoed": input}

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    conn.push({"v": 1, "type": "action.invoke", "invocation_id": "inv-1", "action": "run-etl", "input": {"rows": 3}})
    await wait_until(lambda: len(conn.sent_of_type("action.result")) == 1)
    result = conn.sent_of_type("action.result")[-1]
    assert result == {
        "v": 1,
        "type": "action.result",
        "invocation_id": "inv-1",
        "output": {"echoed": {"rows": 3}},
    }

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_handler_throw_becomes_error_result_never_dropped():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))

    @node.capability("run-etl")
    async def handler(input, ctx):
        raise ValueError("boom")

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    conn.push({"v": 1, "type": "action.invoke", "invocation_id": "inv-err", "action": "run-etl", "input": {}})
    await wait_until(lambda: len(conn.sent_of_type("action.result")) == 1)
    result = conn.sent_of_type("action.result")[-1]
    assert result == {
        "v": 1,
        "type": "action.result",
        "invocation_id": "inv-err",
        "error": "boom",
    }

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_unknown_action_errors_rather_than_dropping():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))
    node.capability("run-etl", lambda input, ctx: "ok")

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    conn.push({"v": 1, "type": "action.invoke", "invocation_id": "inv-x", "action": "nope", "input": {}})
    await wait_until(lambda: len(conn.sent_of_type("action.result")) == 1)
    result = conn.sent_of_type("action.result")[-1]
    assert result["invocation_id"] == "inv-x"
    assert "nope" in result["error"]

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_heartbeat_is_provider_scoped_with_no_last_heartbeat_at():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server, heartbeat_interval=0.02))

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    await wait_until(lambda: len(conn.sent_of_type("node.heartbeat")) >= 1)
    hb = conn.sent_of_type("node.heartbeat")[-1]
    assert hb["provider"] == {"name": "py", "instance_id": node._instance_id}
    assert hb["load"] == 0
    assert hb["active_agents"] == 0
    assert hb["handlers_live"] is True
    assert "last_heartbeat_at" not in hb

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_reconnects_with_new_instance_id_after_unexpected_drop():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))

    task = asyncio.create_task(node.serve())
    first = await server.next_connection()
    first_register = first.last_register()
    first.push(accept_all(first_register))
    await node.wait_registered()
    first_instance = first_register["provider"]["instance_id"]

    first.drop()
    second = await server.next_connection()
    assert second is not first
    second_register = second.last_register()
    assert second_register["name"] == "alpha"
    assert second_register["provider"]["name"] == "py"
    second_instance = second_register["provider"]["instance_id"]
    assert second_instance != first_instance

    second.push(accept_all(second_register))
    await wait_until(lambda: node.connected is True)

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_deregisters_on_graceful_stop():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)

    deregister = conn.sent_of_type("node.deregister")[-1]
    assert deregister["provider"]["name"] == "py"


@pytest.mark.asyncio
async def test_spawn_agent_sends_capacity_direct_node_spawn_frame():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))
    spawn_result: dict = {}

    @node.capability("spawn:claude", kind="action")
    async def handler(input, ctx):
        spawn_result["value"] = await ctx.spawn_agent({"cli": "claude", "name": "worker-1"})
        return spawn_result["value"]

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    conn.push({"v": 1, "type": "action.invoke", "invocation_id": "inv-spawn", "action": "spawn:claude", "input": {}})
    await wait_until(lambda: len(conn.sent_of_type("node.spawn")) == 1)
    spawn_frame = conn.sent_of_type("node.spawn")[-1]
    assert spawn_frame["input"] == {"cli": "claude", "name": "worker-1"}
    # Capacity-direct: the frame carries no node target; the engine uses the
    # connection's own node.
    assert "target_node_id" not in spawn_frame

    conn.push(
        {
            "v": 1,
            "id": spawn_frame["id"],
            "type": "reply",
            "ok": True,
            "data": {"invocation_id": "spawned-1", "status": "dispatched"},
        }
    )
    await wait_until(lambda: len(conn.sent_of_type("action.result")) == 1)
    assert spawn_result["value"]["invocation_id"] == "spawned-1"

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_send_message_sends_node_message_frame():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))
    posted: dict = {}

    @node.capability("run-etl")
    async def handler(input, ctx):
        posted["value"] = await ctx.send_message(to="ops", from_="reporter", text="done")
        return posted["value"]

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    conn.push({"v": 1, "type": "action.invoke", "invocation_id": "inv-msg", "action": "run-etl", "input": {}})
    await wait_until(lambda: len(conn.sent_of_type("node.message")) == 1)
    msg_frame = conn.sent_of_type("node.message")[-1]
    assert msg_frame["to"] == "ops"
    assert msg_frame["from"] == "reporter"
    assert msg_frame["text"] == "done"

    conn.push({"v": 1, "id": msg_frame["id"], "type": "reply", "ok": True, "data": {"id": "m-1", "text": "done"}})
    await wait_until(lambda: "value" in posted)
    assert posted["value"]["id"] == "m-1"

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_ctx_node_exposes_name_and_capability_names():
    server = FakeNodeServer()
    node = NodeProvider(**base_kwargs(server))
    seen: dict = {}

    @node.capability("run-etl")
    async def handler(input, ctx):
        seen["node"] = ctx.node
        seen["invocation_id"] = ctx.invocation_id
        return "ok"

    task = asyncio.create_task(node.serve())
    conn = await server.next_connection()
    conn.push(accept_all(conn.last_register()))
    await node.wait_registered()

    conn.push({"v": 1, "type": "action.invoke", "invocation_id": "inv-ctx", "action": "run-etl", "input": {}})
    await wait_until(lambda: "node" in seen)
    assert seen["node"].name == "alpha"
    assert seen["node"].capabilities == ["run-etl"]
    assert seen["invocation_id"] == "inv-ctx"

    await node.stop()
    await asyncio.wait_for(task, timeout=1.0)
