"""Tests for Relay and AsyncRelay classes."""

import pytest
import httpx
import respx

from relay_sdk import Relay, AsyncRelay, AgentClient, AsyncAgentClient

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
        r = Relay(KEY, base_url=BASE, agent_relay_anonymous_id="abc123def4567890")
        ac = r.as_agent("at_xxx")
        assert isinstance(ac, AgentClient)
        assert ac.client.api_key == "at_xxx"
        assert ac.client.base_url == BASE
        assert ac.client.agent_relay_anonymous_id == "abc123def4567890"

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
        async with AsyncRelay(KEY, base_url=BASE, agent_relay_anonymous_id="abc123def4567890") as r:
            ac = r.as_agent("at_xxx")
            assert isinstance(ac, AsyncAgentClient)
            assert ac.client.agent_relay_anonymous_id == "abc123def4567890"
