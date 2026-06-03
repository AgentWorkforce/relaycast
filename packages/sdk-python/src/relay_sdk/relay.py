"""Relay — top-level client for workspace and agent management."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from .agent import AgentClient, AsyncAgentClient
from .client import AsyncHttpClient, HttpClient
from .errors import RelayError
from .models import Agent, CreateAgentRequest, CreateAgentResponse, TokenRotateResponse, Workspace


def _enc(value: str) -> str:
    return quote(value, safe="")


def _is_duplicate_agent_error(err: RelayError) -> bool:
    return err.status == 409 and err.code in {"agent_already_exists", "name_conflict"}


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

    def register_or_rotate(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreateAgentResponse:
        try:
            return self.register(name, type=type, persona=persona, metadata=metadata)
        except RelayError as err:
            if not _is_duplicate_agent_error(err):
                raise

        agent = self.get(name)
        rotated = self.rotate_token(agent.name)
        return CreateAgentResponse(
            id=agent.id,
            name=agent.name,
            token=rotated.token,
            status=agent.status,
            created_at=agent.created_at,
        )

    def list(self, *, status: str | None = None) -> list[Agent]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        result = self._client.get("/v1/agents", query or None)
        return [Agent.model_validate(a) for a in result]

    def get(self, name: str) -> Agent:
        result = self._client.get(f"/v1/agents/{_enc(name)}")
        return Agent.model_validate(result)

    def rotate_token(self, name: str) -> TokenRotateResponse:
        result = self._client.post(f"/v1/agents/{_enc(name)}/rotate-token", {})
        return TokenRotateResponse.model_validate(result)


class Relay:
    """Synchronous Relay client.

    Usage::

        relay = Relay(api_key="rk_live_xxx")
        agent = relay.agents.register(name="Coder", persona="Senior developer")
        me = relay.as_agent(agent.token)
        me.send("#general", "Hello from Python")
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        origin_surface: str | None = None,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_anonymous_id: str | None = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("Relay api_key is required")

        self._client = HttpClient(
            api_key,
            base_url,
            origin_surface=origin_surface,
            origin_client=origin_client,
            origin_version=origin_version,
            agent_relay_anonymous_id=agent_relay_anonymous_id,
        )
        self.workspace = _WorkspaceNamespace(self._client)
        self.agents = _AgentsNamespace(self._client)

    def as_agent(self, agent_token: str) -> AgentClient:
        agent_client = HttpClient(
            agent_token,
            self._client.base_url,
            origin_surface=self._client.origin_surface,
            origin_client=self._client.origin_client,
            origin_version=self._client.origin_version,
            agent_relay_anonymous_id=self._client.agent_relay_anonymous_id,
        )
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

    async def register_or_rotate(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreateAgentResponse:
        try:
            return await self.register(name, type=type, persona=persona, metadata=metadata)
        except RelayError as err:
            if not _is_duplicate_agent_error(err):
                raise

        agent = await self.get(name)
        rotated = await self.rotate_token(agent.name)
        return CreateAgentResponse(
            id=agent.id,
            name=agent.name,
            token=rotated.token,
            status=agent.status,
            created_at=agent.created_at,
        )

    async def list(self, *, status: str | None = None) -> list[Agent]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        result = await self._client.get("/v1/agents", query or None)
        return [Agent.model_validate(a) for a in result]

    async def get(self, name: str) -> Agent:
        result = await self._client.get(f"/v1/agents/{_enc(name)}")
        return Agent.model_validate(result)

    async def rotate_token(self, name: str) -> TokenRotateResponse:
        result = await self._client.post(f"/v1/agents/{_enc(name)}/rotate-token", {})
        return TokenRotateResponse.model_validate(result)


class AsyncRelay:
    """Asynchronous Relay client.

    Usage::

        async with AsyncRelay(api_key="rk_live_xxx") as relay:
            agent = await relay.agents.register(name="Coder", persona="Senior developer")
            me = relay.as_agent(agent.token)
            await me.send("#general", "Hello from Python")
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        origin_surface: str | None = None,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_anonymous_id: str | None = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("Relay api_key is required")

        self._client = AsyncHttpClient(
            api_key,
            base_url,
            origin_surface=origin_surface,
            origin_client=origin_client,
            origin_version=origin_version,
            agent_relay_anonymous_id=agent_relay_anonymous_id,
        )
        self.workspace = _AsyncWorkspaceNamespace(self._client)
        self.agents = _AsyncAgentsNamespace(self._client)

    def as_agent(self, agent_token: str) -> AsyncAgentClient:
        agent_client = AsyncHttpClient(
            agent_token,
            self._client.base_url,
            origin_surface=self._client.origin_surface,
            origin_client=self._client.origin_client,
            origin_version=self._client.origin_version,
            agent_relay_anonymous_id=self._client.agent_relay_anonymous_id,
        )
        return AsyncAgentClient(agent_client)

    as_ = as_agent

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> AsyncRelay:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
