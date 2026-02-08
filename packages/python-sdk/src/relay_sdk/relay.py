"""Relay — top-level client for workspace and agent management."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .agent import AgentClient, AsyncAgentClient
from .billing import AsyncBillingClient, BillingClient
from .client import AsyncHttpClient, HttpClient
from .models import Agent, CreateAgentRequest, CreateAgentResponse, Workspace


def _enc(value: str) -> str:
    return quote(value, safe="")


class _WorkspaceNamespace:
    """Sync workspace operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def info(self) -> Workspace:
        result = self._client.get("/v1/workspace")
        return Workspace.model_validate(result)

    def update(self, *, name: str | None = None, system_prompt: str | None = None) -> Workspace:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        result = self._client.patch("/v1/workspace", body)
        return Workspace.model_validate(result)


class _AgentsNamespace:
    """Sync agent operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def register(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreateAgentResponse:
        data = CreateAgentRequest(
            name=name,
            type=type,  # type: ignore[arg-type]
            persona=persona,
            metadata=metadata,
        )
        result = self._client.post("/v1/agents", data.model_dump(exclude_none=True))
        return CreateAgentResponse.model_validate(result)

    def list(self, *, status: str | None = None) -> list[Agent]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        result = self._client.get("/v1/agents", query or None)
        return [Agent.model_validate(a) for a in result]

    def get(self, name: str) -> Agent:
        result = self._client.get(f"/v1/agents/{_enc(name)}")
        return Agent.model_validate(result)


class Relay:
    """Synchronous Relay client.

    Usage::

        relay = Relay(api_key="rk_live_xxx")
        agent = relay.agents.register(name="Coder", persona="Senior developer")
        me = relay.as_agent(agent.token)
        me.send("#general", "Hello from Python")
    """

    def __init__(self, api_key: str, *, base_url: str | None = None) -> None:
        self._client = HttpClient(api_key, base_url)
        self.workspace = _WorkspaceNamespace(self._client)
        self.agents = _AgentsNamespace(self._client)
        self.billing = BillingClient(self._client)

    def as_agent(self, agent_token: str) -> AgentClient:
        agent_client = HttpClient(agent_token, self._client.base_url)
        return AgentClient(agent_client)

    # Alias for TS SDK compat
    as_ = as_agent

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Relay:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


# ── Async variants ────────────────────────────────────────────────


class _AsyncWorkspaceNamespace:
    """Async workspace operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def info(self) -> Workspace:
        result = await self._client.get("/v1/workspace")
        return Workspace.model_validate(result)

    async def update(self, *, name: str | None = None, system_prompt: str | None = None) -> Workspace:
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        result = await self._client.patch("/v1/workspace", body)
        return Workspace.model_validate(result)


class _AsyncAgentsNamespace:
    """Async agent operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def register(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreateAgentResponse:
        data = CreateAgentRequest(
            name=name,
            type=type,  # type: ignore[arg-type]
            persona=persona,
            metadata=metadata,
        )
        result = await self._client.post("/v1/agents", data.model_dump(exclude_none=True))
        return CreateAgentResponse.model_validate(result)

    async def list(self, *, status: str | None = None) -> list[Agent]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        result = await self._client.get("/v1/agents", query or None)
        return [Agent.model_validate(a) for a in result]

    async def get(self, name: str) -> Agent:
        result = await self._client.get(f"/v1/agents/{_enc(name)}")
        return Agent.model_validate(result)


class AsyncRelay:
    """Asynchronous Relay client.

    Usage::

        async with AsyncRelay(api_key="rk_live_xxx") as relay:
            agent = await relay.agents.register(name="Coder", persona="Senior developer")
            me = relay.as_agent(agent.token)
            await me.send("#general", "Hello from Python")
    """

    def __init__(self, api_key: str, *, base_url: str | None = None) -> None:
        self._client = AsyncHttpClient(api_key, base_url)
        self.workspace = _AsyncWorkspaceNamespace(self._client)
        self.agents = _AsyncAgentsNamespace(self._client)
        self.billing = AsyncBillingClient(self._client)

    def as_agent(self, agent_token: str) -> AsyncAgentClient:
        agent_client = AsyncHttpClient(agent_token, self._client.base_url)
        return AsyncAgentClient(agent_client)

    as_ = as_agent

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> AsyncRelay:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
