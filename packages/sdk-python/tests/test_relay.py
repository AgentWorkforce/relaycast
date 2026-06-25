"""Tests for Relay and AsyncRelay classes."""

import json

import pytest
import httpx
import respx

from relay_sdk import Relay, AsyncRelay, AgentClient, AsyncAgentClient
from relay_sdk.models import (
    BindAgentToNodeRequest,
    CreateNodeRequest,
    HttpPushNodeDelivery,
    NodeDeliveryAuth,
)

BASE = "https://test.relay.dev"
KEY = "rk_test_abc"


def ok(data):
    return httpx.Response(200, json={"ok": True, "data": data})


WORKSPACE_DATA = {
    "id": "w1",
    "name": "TestWS",
    "api_key_hash": "hash",
    "system_prompt": None,
    "created_at": "2025-01-01T00:00:00Z",
    "metadata": {},
}

AGENT_DATA = {
    "id": "a1",
    "workspace_id": "w1",
    "name": "Coder",
    "type": "agent",
    "token_hash": "hash",
    "status": "online",
    "persona": "Senior dev",
    "metadata": {},
    "created_at": "2025-01-01T00:00:00Z",
    "last_seen": "2025-01-01T00:00:00Z",
}

CREATE_AGENT_DATA = {
    "id": "a1",
    "name": "Coder",
    "token": "at_xxx",
    "status": "online",
    "created_at": "2025-01-01T00:00:00Z",
}

NODE_DATA = {
    "id": "node_1",
    "name": "http-node",
    "kind": "http_push",
    "role": "direct",
    "delivery_adapter": "http.hmac.v1",
    "delivery": {
        "url": "https://receiver.example.test/relaycast",
        "ack_mode": "manual",
        "auth": {"type": "hmac_sha256", "secret": "[redacted]"},
    },
    "capabilities": [{"name": "code", "kind": "executor"}],
    "tags": ["primary"],
    "version": "1.2.3",
    "status": "offline",
    "live": False,
    "handlers_live": False,
    "load": 0,
    "active_agents": 0,
    "max_agents": 1,
    "last_heartbeat_at": None,
    "created_at": "2026-06-01T00:00:00Z",
}

NODE_BINDING_DATA = {
    "id": "anb_1",
    "agent_id": "agent_1",
    "agent_name": "billing-agent",
    "node_id": "node_1",
    "node_name": "http-node",
    "node_kind": "http_push",
    "node_role": "direct",
    "status": "active",
    "session_ref": None,
    "priority": 5,
    "created_at": "2026-06-01T00:00:00Z",
    "updated_at": None,
}


class TestRelay:
    def test_constructor(self):
        r = Relay(KEY, base_url=BASE)
        assert r._client.api_key == KEY
        assert r._client.base_url == BASE

    def test_constructor_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            Relay(None, base_url=BASE)

    @respx.mock
    def test_workspace_info(self):
        respx.get(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE_DATA))
        r = Relay(KEY, base_url=BASE)
        ws = r.workspace.info()
        assert ws.name == "TestWS"

    @respx.mock
    def test_workspace_update(self):
        updated = {**WORKSPACE_DATA, "name": "NewName"}
        respx.patch(f"{BASE}/v1/workspace").mock(return_value=ok(updated))
        r = Relay(KEY, base_url=BASE)
        ws = r.workspace.update(name="NewName")
        assert ws.name == "NewName"

    @respx.mock
    def test_agents_register(self):
        route = respx.post(f"{BASE}/v1/agents").mock(return_value=ok(CREATE_AGENT_DATA))
        r = Relay(KEY, base_url=BASE)
        agent = r.agents.register("Coder", persona="Senior dev")
        assert agent.name == "Coder"
        assert agent.token == "at_xxx"
        assert route.called

    @respx.mock
    def test_agents_list(self):
        respx.get(f"{BASE}/v1/agents").mock(return_value=ok([AGENT_DATA]))
        r = Relay(KEY, base_url=BASE)
        agents = r.agents.list()
        assert len(agents) == 1
        assert agents[0].name == "Coder"

    @respx.mock
    def test_agents_list_with_status(self):
        route = respx.get(f"{BASE}/v1/agents").mock(return_value=ok([AGENT_DATA]))
        r = Relay(KEY, base_url=BASE)
        r.agents.list(status="online")
        req = route.calls[0].request
        assert "status=online" in str(req.url)

    @respx.mock
    def test_agents_get(self):
        respx.get(f"{BASE}/v1/agents/Coder").mock(return_value=ok(AGENT_DATA))
        r = Relay(KEY, base_url=BASE)
        agent = r.agents.get("Coder")
        assert agent.name == "Coder"

    @respx.mock
    def test_agents_rotate_token(self):
        route = respx.post(f"{BASE}/v1/agents/Coder/rotate-token").mock(
            return_value=ok({"token": "at_rotated"})
        )
        r = Relay(KEY, base_url=BASE)
        rotated = r.agents.rotate_token("Coder")
        assert rotated.token == "at_rotated"
        assert route.called

    @respx.mock
    def test_agents_delete(self):
        route = respx.delete(f"{BASE}/v1/agents/Coder").mock(return_value=ok(None))
        r = Relay(KEY, base_url=BASE)
        assert r.agents.delete("Coder") is None
        assert route.called

    @respx.mock
    def test_agents_delete_204_empty_body(self):
        # Production returns 204 No Content with an empty body for DELETE.
        route = respx.delete(f"{BASE}/v1/agents/Coder").mock(
            return_value=httpx.Response(204)
        )
        r = Relay(KEY, base_url=BASE)
        assert r.agents.delete("Coder") is None
        assert route.called

    @respx.mock
    def test_agents_unregister_alias(self):
        route = respx.delete(f"{BASE}/v1/agents/Coder").mock(return_value=ok(None))
        r = Relay(KEY, base_url=BASE)
        assert r.agents.unregister("Coder") is None
        assert route.called

    @respx.mock
    def test_nodes_create_list_bind_and_unbind(self):
        create_route = respx.post(f"{BASE}/v1/nodes").mock(
            return_value=ok({**NODE_DATA, "token": "nt_live_test"})
        )
        r = Relay(KEY, base_url=BASE)
        created = r.nodes.create(
            CreateNodeRequest(
                name="http-node",
                kind="http_push",
                delivery=HttpPushNodeDelivery(
                    url="https://receiver.example.test/relaycast",
                    ack_mode="manual",
                    auth=NodeDeliveryAuth(
                        type="hmac_sha256",
                        secret="secret",
                        signature_header="X-Custom-Signature",
                        timestamp_header="X-Custom-Timestamp",
                        signed_payload="timestamp.body",
                        prefix="sig=",
                    ),
                ),
            )
        )
        assert created.kind == "http_push"
        assert created.token == "nt_live_test"
        create_body = json.loads(create_route.calls[0].request.content)
        assert create_body["delivery"]["auth"]["signature_header"] == "X-Custom-Signature"

        list_route = respx.get(f"{BASE}/v1/nodes").mock(return_value=ok([NODE_DATA]))
        nodes = r.nodes.list(capability="code")
        assert nodes[0].name == "http-node"
        assert nodes[0].delivery_adapter == "http.hmac.v1"
        assert "capability=code" in str(list_route.calls[0].request.url)

        respx.get(f"{BASE}/v1/nodes/http-node").mock(return_value=ok(NODE_DATA))
        assert r.nodes.get("http-node").max_agents == 1

        respx.get(f"{BASE}/v1/nodes/http-node/agents").mock(return_value=ok([NODE_BINDING_DATA]))
        assert r.nodes.list_agents("http-node")[0].agent_name == "billing-agent"

        bind_route = respx.post(f"{BASE}/v1/nodes/http-node/agents").mock(return_value=ok(NODE_BINDING_DATA))
        binding = r.nodes.bind_agent("http-node", BindAgentToNodeRequest(agent_name="billing-agent", priority=5))
        assert binding.priority == 5
        bind_body = json.loads(bind_route.calls[0].request.content)
        assert bind_body["agent_name"] == "billing-agent"

        unbind_route = respx.delete(f"{BASE}/v1/nodes/http-node/agents/billing-agent").mock(
            return_value=httpx.Response(204)
        )
        assert r.nodes.unbind_agent("http-node", "billing-agent") is None
        assert unbind_route.called

    @respx.mock
    def test_agents_register_or_rotate_registers_new_agent(self):
        respx.post(f"{BASE}/v1/agents").mock(return_value=ok(CREATE_AGENT_DATA))
        r = Relay(KEY, base_url=BASE)
        created = r.agents.register_or_rotate("Coder", persona="Senior dev")
        assert created.token == "at_xxx"

    @respx.mock
    @pytest.mark.parametrize("error_code", ["agent_already_exists", "name_conflict"])
    def test_agents_register_or_rotate_rotates_existing_agent(self, error_code):
        respx.post(f"{BASE}/v1/agents").mock(
            return_value=httpx.Response(
                409,
                json={"ok": False, "error": {"code": error_code, "message": "exists"}},
            )
        )
        get_route = respx.get(f"{BASE}/v1/agents/Coder").mock(return_value=ok(AGENT_DATA))
        rotate_route = respx.post(f"{BASE}/v1/agents/Coder/rotate-token").mock(
            return_value=ok({"token": "at_rotated"})
        )
        r = Relay(KEY, base_url=BASE)
        created = r.agents.register_or_rotate("Coder")
        assert created.id == "a1"
        assert created.token == "at_rotated"
        assert get_route.called
        assert rotate_route.called

    def test_as_agent_returns_agent_client(self):
        r = Relay(KEY, base_url=BASE, agent_relay_distinct_id="abc123def4567890")
        ac = r.as_agent("at_xxx")
        assert isinstance(ac, AgentClient)
        assert ac.client.api_key == "at_xxx"
        assert ac.client.base_url == BASE
        assert ac.client.agent_relay_distinct_id == "abc123def4567890"

    def test_as_alias(self):
        r = Relay(KEY, base_url=BASE)
        assert r.as_ == r.as_agent

    def test_context_manager(self):
        with Relay(KEY, base_url=BASE) as r:
            assert r._client.api_key == KEY


class TestAsyncRelay:
    @pytest.mark.asyncio
    async def test_constructor_requires_api_key(self):
        with pytest.raises(ValueError, match="api_key is required"):
            AsyncRelay(None, base_url=BASE)

    @pytest.mark.asyncio
    @respx.mock
    async def test_workspace_info(self):
        respx.get(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE_DATA))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            ws = await r.workspace.info()
            assert ws.name == "TestWS"

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_register(self):
        respx.post(f"{BASE}/v1/agents").mock(return_value=ok(CREATE_AGENT_DATA))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            agent = await r.agents.register("Coder")
            assert agent.token == "at_xxx"

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_list(self):
        respx.get(f"{BASE}/v1/agents").mock(return_value=ok([AGENT_DATA]))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            agents = await r.agents.list()
            assert len(agents) == 1

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_get(self):
        respx.get(f"{BASE}/v1/agents/Coder").mock(return_value=ok(AGENT_DATA))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            agent = await r.agents.get("Coder")
            assert agent.status == "online"

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_rotate_token(self):
        respx.post(f"{BASE}/v1/agents/Coder/rotate-token").mock(return_value=ok({"token": "at_rotated"}))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            rotated = await r.agents.rotate_token("Coder")
            assert rotated.token == "at_rotated"

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_delete(self):
        route = respx.delete(f"{BASE}/v1/agents/Coder").mock(return_value=ok(None))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            assert await r.agents.delete("Coder") is None
        assert route.called

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_delete_204_empty_body(self):
        # Production returns 204 No Content with an empty body for DELETE.
        route = respx.delete(f"{BASE}/v1/agents/Coder").mock(
            return_value=httpx.Response(204)
        )
        async with AsyncRelay(KEY, base_url=BASE) as r:
            assert await r.agents.delete("Coder") is None
        assert route.called

    @pytest.mark.asyncio
    @respx.mock
    async def test_agents_unregister_alias(self):
        route = respx.delete(f"{BASE}/v1/agents/Coder").mock(return_value=ok(None))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            assert await r.agents.unregister("Coder") is None
        assert route.called

    @pytest.mark.asyncio
    @respx.mock
    async def test_nodes_async_create_and_bind(self):
        create_route = respx.post(f"{BASE}/v1/nodes").mock(
            return_value=ok({**NODE_DATA, "token": "nt_live_test"})
        )
        bind_route = respx.post(f"{BASE}/v1/nodes/http-node/agents").mock(return_value=ok(NODE_BINDING_DATA))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            created = await r.nodes.create(
                CreateNodeRequest(
                    name="http-node",
                    kind="http_push",
                    delivery=HttpPushNodeDelivery(url="https://receiver.example.test/relaycast"),
                )
            )
            binding = await r.nodes.bind_agent(
                "http-node",
                BindAgentToNodeRequest(agent_name="billing-agent"),
            )
        assert created.token == "nt_live_test"
        assert binding.agent_name == "billing-agent"
        assert create_route.called
        assert bind_route.called

    @pytest.mark.asyncio
    @pytest.mark.parametrize("error_code", ["agent_already_exists", "name_conflict"])
    @respx.mock
    async def test_agents_register_or_rotate_rotates_existing_agent(self, error_code):
        respx.post(f"{BASE}/v1/agents").mock(
            return_value=httpx.Response(
                409,
                json={"ok": False, "error": {"code": error_code, "message": "exists"}},
            )
        )
        respx.get(f"{BASE}/v1/agents/Coder").mock(return_value=ok(AGENT_DATA))
        respx.post(f"{BASE}/v1/agents/Coder/rotate-token").mock(return_value=ok({"token": "at_rotated"}))
        async with AsyncRelay(KEY, base_url=BASE) as r:
            created = await r.agents.register_or_rotate("Coder")
            assert created.id == "a1"
            assert created.token == "at_rotated"

    @pytest.mark.asyncio
    async def test_as_agent_returns_async_client(self):
        async with AsyncRelay(KEY, base_url=BASE, agent_relay_distinct_id="abc123def4567890") as r:
            ac = r.as_agent("at_xxx")
            assert isinstance(ac, AsyncAgentClient)
            assert ac.client.agent_relay_distinct_id == "abc123def4567890"
