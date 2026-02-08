"""Tests for Relay and AsyncRelay classes."""

import pytest
import httpx
import respx

from relay_sdk import Relay, AsyncRelay, AgentClient, AsyncAgentClient, BillingClient
from relay_sdk.billing import AsyncBillingClient

BASE = "https://test.relay.dev"
KEY = "rk_test_abc"


def ok(data):
    return httpx.Response(200, json={"ok": True, "data": data})


WORKSPACE_DATA = {
    "id": "w1",
    "name": "TestWS",
    "api_key_hash": "hash",
    "plan": "free",
    "system_prompt": None,
    "stripe_customer_id": None,
    "stripe_subscription_id": None,
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


class TestRelay:
    def test_constructor(self):
        r = Relay(KEY, base_url=BASE)
        assert r._client.api_key == KEY
        assert r._client.base_url == BASE

    def test_has_billing(self):
        r = Relay(KEY, base_url=BASE)
        assert isinstance(r.billing, BillingClient)

    @respx.mock
    def test_workspace_info(self):
        respx.get(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE_DATA))
        r = Relay(KEY, base_url=BASE)
        ws = r.workspace.info()
        assert ws.name == "TestWS"
        assert ws.plan == "free"

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

    def test_as_agent_returns_agent_client(self):
        r = Relay(KEY, base_url=BASE)
        ac = r.as_agent("at_xxx")
        assert isinstance(ac, AgentClient)
        assert ac.client.api_key == "at_xxx"
        assert ac.client.base_url == BASE

    def test_as_alias(self):
        r = Relay(KEY, base_url=BASE)
        assert r.as_ == r.as_agent

    def test_context_manager(self):
        with Relay(KEY, base_url=BASE) as r:
            assert r._client.api_key == KEY


class TestAsyncRelay:
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
    async def test_as_agent_returns_async_client(self):
        async with AsyncRelay(KEY, base_url=BASE) as r:
            ac = r.as_agent("at_xxx")
            assert isinstance(ac, AsyncAgentClient)

    @pytest.mark.asyncio
    async def test_has_async_billing(self):
        async with AsyncRelay(KEY, base_url=BASE) as r:
            assert isinstance(r.billing, AsyncBillingClient)
