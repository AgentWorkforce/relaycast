"""Relay — top-level client for workspace and agent management."""

from __future__ import annotations

from typing import Any
from ipaddress import ip_address
from urllib.parse import quote, urlsplit

from .agent import AgentClient, AsyncAgentClient
from .client import AsyncHttpClient, HttpClient
from .models import (
    A2aAgentCard,
    A2aAgentRecord,
    DirectoryAgent,
    DirectoryRating,
    DirectorySearchResult,
    ImportSkillsRequest,
    BindAgentToNodeRequest,
    CreateNodeRequest,
    CreateNodeResponse,
    RateDirectoryAgentRequest,
    RegisterA2aOptions,
    RegisterA2aResponse,
    RemoveA2aAgentResponse,
    NodeAgentBinding,
    NodeRosterEntry,
    RouteFeedbackRequest,
    RouteFeedbackResult,
    RouteResult,
    RoutingConfig,
    SkillSearchResult,
    UpdateDirectoryAgentRequest,
    UpdateRoutingConfigRequest,
    Agent,
    CreateAgentRequest,
    CreateAgentResponse,
    CreateWorkspaceRequest,
    CreateWorkspaceResponse,
    CreateObserverTokenRequest,
    ObserverToken,
    PublishToDirectoryRequest,
    TokenRotateResponse,
    UpdateObserverTokenRequest,
    Workspace,
)


def _enc(value: str) -> str:
    return quote(value, safe="")


def _workspace_create_headers(
    idempotency_key: str | None, api_key: str | None, base_url: str | None,
) -> dict[str, str]:
    if idempotency_key is None:
        return {}
    # Preserve authenticated keys exactly, including an explicitly empty key,
    # so the API owns invalid_idempotency_key errors as in the TypeScript SDK.
    if not api_key:
        if len(idempotency_key) < 32:
            raise ValueError("Anonymous idempotency_key must be at least 32 characters")
        if len(idempotency_key) > 255 or not all("!" <= char <= "~" for char in idempotency_key):
            raise ValueError("idempotency_key must contain 1-255 visible ASCII characters")
        destination = urlsplit(base_url or "https://cast.agentrelay.com")
        host = destination.hostname or ""
        loopback = host.lower() == "localhost"
        try:
            loopback = loopback or ip_address(host).is_loopback
        except ValueError:
            pass
        if not host or destination.username is not None or destination.password is not None or not (
            destination.scheme == "https" or (destination.scheme == "http" and loopback)
        ):
            raise ValueError("Anonymous keyed workspace creation requires HTTPS or loopback HTTP")
    return {"Idempotency-Key": idempotency_key}


class _WorkspaceNamespace:
    """Sync workspace operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def info(self) -> Workspace:
        result = self._client.get("/v1/workspace")
        return Workspace.model_validate(result)

    def update(
        self, *, name: str | None = None, system_prompt: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Workspace:
        """Update workspace fields; metadata shallow-merges, with null values deleting keys."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if metadata is not None:
            body["metadata"] = metadata
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
        recovery_proof_hash: str | None = None,
        work_unit_id: str | None = None,
    ) -> CreateAgentResponse:
        data = CreateAgentRequest(
            name=name,
            type=type,  # type: ignore[arg-type]
            persona=persona,
            metadata=metadata,
            recovery_proof_hash=recovery_proof_hash,
            work_unit_id=work_unit_id,
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
        recovery_proof_hash: str | None = None,
        work_unit_id: str | None = None,
    ) -> CreateAgentResponse:
        """Deprecated create-only alias; collisions fail closed."""
        return self.register(
            name,
            type=type,
            persona=persona,
            metadata=metadata,
            recovery_proof_hash=recovery_proof_hash,
            work_unit_id=work_unit_id,
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

    def rotate_token(self, name: str, *, agent_token: str) -> TokenRotateResponse:
        with self._client.with_api_key(agent_token) as client:
            result = client.post(f"/v1/agents/{_enc(name)}/rotate-token", {})
        return TokenRotateResponse.model_validate(result)

    def recover(
        self,
        name: str,
        *,
        expected_agent_id: str,
        recovery_proof: str | None = None,
        reason: str | None = None,
        session_ref: str | None = None,
        node_id: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "expected_agent_id": expected_agent_id,
            "recovery_proof": recovery_proof,
            "reason": reason,
            "session_ref": session_ref,
            "node_id": node_id,
        }
        return self._client.post(
            f"/v1/agents/{_enc(name)}/recover",
            {key: value for key, value in body.items() if value is not None},
        )

    def take_over(
        self,
        name: str,
        *,
        expected_agent_id: str,
        actor: str,
        reason: str,
        session_ref: str,
        node_id: str,
    ) -> dict[str, Any]:
        return self._client.post(f"/v1/agents/{_enc(name)}/takeover", {
            "expected_agent_id": expected_agent_id,
            "actor": actor,
            "reason": reason,
            "session_ref": session_ref,
            "node_id": node_id,
        })

    def revoke_token(
        self,
        name: str,
        *,
        expected_agent_id: str,
        actor: str,
        reason: str,
        session_ref: str | None = None,
        node_id: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "expected_agent_id": expected_agent_id,
            "actor": actor,
            "reason": reason,
            "session_ref": session_ref,
            "node_id": node_id,
        }
        return self._client.post(
            f"/v1/agents/{_enc(name)}/revoke-token",
            {key: value for key, value in body.items() if value is not None},
        )

    def enroll_recovery_credential(
        self,
        *,
        agent_token: str,
        recovery_proof_hash: str,
        work_unit_id: str | None = None,
    ) -> dict[str, Any]:
        body = {"recovery_proof_hash": recovery_proof_hash, "work_unit_id": work_unit_id}
        with self._client.with_api_key(agent_token) as client:
            return client.post(
                "/v1/agent/recovery-credential",
                {key: value for key, value in body.items() if value is not None},
            )

    def delete(self, name: str) -> None:
        self._client.delete(f"/v1/agents/{_enc(name)}")

    # Alias for TS SDK compat
    unregister = delete


class _NodesNamespace:
    """Sync node operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def create(
        self,
        data: CreateNodeRequest,
        *,
        current_token: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateNodeResponse:
        if idempotency_key is not None and current_token is None:
            raise ValueError("idempotency_key requires current_token for node rotation recovery")
        headers = {
            **({"X-Relaycast-Node-Token": current_token} if current_token is not None else {}),
            **({"Idempotency-Key": idempotency_key} if idempotency_key is not None else {}),
        }
        result = self._client.post(
            "/v1/nodes",
            data.model_dump(exclude_none=True),
            headers=headers or None,
            retry=idempotency_key is not None,
        )
        return CreateNodeResponse.model_validate(result)

    def list(self, *, capability: str | None = None, name: str | None = None) -> list[NodeRosterEntry]:
        query: dict[str, str] = {}
        if capability:
            query["capability"] = capability
        if name:
            query["name"] = name
        result = self._client.get("/v1/nodes", query or None)
        return [NodeRosterEntry.model_validate(node) for node in result]

    def get(self, name: str) -> NodeRosterEntry:
        result = self._client.get(f"/v1/nodes/{_enc(name)}")
        return NodeRosterEntry.model_validate(result)

    def list_agents(self, name: str) -> list[NodeAgentBinding]:
        result = self._client.get(f"/v1/nodes/{_enc(name)}/agents")
        return [NodeAgentBinding.model_validate(binding) for binding in result]

    def bind_agent(self, name: str, data: BindAgentToNodeRequest) -> NodeAgentBinding:
        result = self._client.post(f"/v1/nodes/{_enc(name)}/agents", data.model_dump(exclude_none=True))
        return NodeAgentBinding.model_validate(result)

    def unbind_agent(self, name: str, agent_name: str) -> None:
        self._client.delete(f"/v1/nodes/{_enc(name)}/agents/{_enc(agent_name)}")


class _ObserverTokensNamespace:
    """Sync observer-token operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def create(self, data: CreateObserverTokenRequest) -> ObserverToken:
        result = self._client.post("/v1/observer-tokens", data.model_dump(exclude_none=True))
        return ObserverToken.model_validate(result)

    def list(self) -> list[ObserverToken]:
        result = self._client.get("/v1/observer-tokens")
        return [ObserverToken.model_validate(token) for token in result]

    def get(self, token_id: str) -> ObserverToken:
        result = self._client.get(f"/v1/observer-tokens/{_enc(token_id)}")
        return ObserverToken.model_validate(result)

    def update(self, token_id: str, data: UpdateObserverTokenRequest) -> ObserverToken:
        result = self._client.patch(f"/v1/observer-tokens/{_enc(token_id)}", data.model_dump(exclude_none=True))
        return ObserverToken.model_validate(result)

    def rotate(self, token_id: str) -> ObserverToken:
        result = self._client.post(f"/v1/observer-tokens/{_enc(token_id)}/rotate", {})
        return ObserverToken.model_validate(result)

    def revoke(self, token_id: str) -> None:
        self._client.delete(f"/v1/observer-tokens/{_enc(token_id)}")


class Relay:
    """Synchronous Relay client.

    Usage::

        relay = Relay(api_key="rk_live_xxx")
        agent = relay.agents.register(name="Coder", persona="Senior developer")
        me = relay.as_agent(agent.token)
        me.send("#general", "Hello from Python")
    """

    @staticmethod
    def create_workspace(
        name: str, *, metadata: dict[str, Any] | None = None,
        api_key: str | None = None, base_url: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateWorkspaceResponse:
        """Create a workspace; automatic retries require an idempotency key.

        Anonymous keys are reveal-once recovery capabilities: generate with a
        CSPRNG (for example uuid.uuid4()), and retain the key for safe retries.
        An owner api_key scopes delegated keys to that owner.
        """
        headers = _workspace_create_headers(idempotency_key, api_key, base_url)
        data = CreateWorkspaceRequest(name=name, metadata=metadata)
        with HttpClient(api_key or "", base_url) as client:
            result = client.request(
                "POST", "/v1/workspaces", data.model_dump(exclude_none=True),
                headers=headers, retry=idempotency_key is not None,
            )
        return CreateWorkspaceResponse.model_validate(result)

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_distinct_id: str | None = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("Relay api_key is required")

        self._client = HttpClient(
            api_key,
            base_url,
            origin_client=origin_client,
            origin_version=origin_version,
            agent_relay_distinct_id=agent_relay_distinct_id,
        )
        self.workspace = _WorkspaceNamespace(self._client)
        self.agents = _AgentsNamespace(self._client)
        self.nodes = _NodesNamespace(self._client)
        self.observer_tokens = _ObserverTokensNamespace(self._client)


    def register_agent(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
        recovery_proof_hash: str | None = None,
        work_unit_id: str | None = None,
    ) -> CreateAgentResponse:
        return self.agents.register(
            name,
            type=type,
            persona=persona,
            metadata=metadata,
            recovery_proof_hash=recovery_proof_hash,
            work_unit_id=work_unit_id,
        )

    def register_or_rotate(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreateAgentResponse:
        return self.agents.register_or_rotate(name, type=type, persona=persona, metadata=metadata)

    def agent(self, name: str, *, persona: str | None = None, metadata: dict[str, Any] | None = None) -> CreateAgentResponse:
        return self.register_agent(name, type="agent", persona=persona, metadata=metadata)

    def human(self, name: str, *, persona: str | None = None, metadata: dict[str, Any] | None = None) -> CreateAgentResponse:
        return self.register_agent(name, type="human", persona=persona, metadata=metadata)

    def system(self, name: str, *, persona: str | None = None, metadata: dict[str, Any] | None = None) -> CreateAgentResponse:
        return self.register_agent(name, type="system", persona=persona, metadata=metadata)

    def register_a2a(self, options: RegisterA2aOptions) -> RegisterA2aResponse:
        result = self._client.post("/v1/a2a/register", options.model_dump(exclude_none=True))
        return RegisterA2aResponse.model_validate(result)

    def list_a2a_agents(self) -> list[A2aAgentRecord]:
        result = self._client.get("/v1/a2a/agents")
        return [A2aAgentRecord.model_validate(a) for a in result]

    def remove_a2a_agent(self, name: str) -> RemoveA2aAgentResponse:
        result = self._client.request("DELETE", f"/v1/a2a/agents/{_enc(name)}")
        return RemoveA2aAgentResponse.model_validate(result)

    def get_a2a_agent_card(self, name: str) -> A2aAgentCard:
        result = self._client.get(f"/v1/a2a/agents/{_enc(name)}/card")
        return A2aAgentCard.model_validate(result)

    def route(self, skill: str, message: str | None = None) -> RouteResult:
        result = self._client.post("/v1/route", {"skill": skill, "message": message})
        return RouteResult.model_validate(result)

    def search_directory(
        self, *, q: str | None = None, tags: list[str] | None = None, status: str | None = None, limit: int | None = None
    ) -> list[DirectorySearchResult]:
        query: dict[str, str] = {}
        if q:
            query["q"] = q
        if tags:
            query["tags"] = ",".join(tags)
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = str(limit)
        result = self._client.get("/v1/directory/search", query or None)
        return [DirectorySearchResult.model_validate(a) for a in result]

    def publish_to_directory(self, data: PublishToDirectoryRequest) -> DirectoryAgent:
        result = self._client.post("/v1/directory/agents", data.model_dump(exclude_none=True))
        return DirectoryAgent.model_validate(result)

    def import_skills(self, data: ImportSkillsRequest) -> DirectoryAgent | None:
        result = self._client.post("/v1/skills/sync", data.model_dump(exclude_none=True))
        return DirectoryAgent.model_validate(result) if result is not None else None

    def search_skills(self, *, q: str | None = None, limit: int | None = None) -> list[SkillSearchResult]:
        query: dict[str, str] = {}
        if q:
            query["q"] = q
        if limit is not None:
            query["limit"] = str(limit)
        result = self._client.get("/v1/skills/search", query or None)
        return [SkillSearchResult.model_validate(s) for s in result]

    def route_feedback(self, data: RouteFeedbackRequest) -> RouteFeedbackResult:
        result = self._client.post("/v1/route/feedback", data.model_dump(exclude_none=True))
        return RouteFeedbackResult.model_validate(result)

    def list_directory(self, *, status: str | None = None, limit: int | None = None) -> list[DirectoryAgent]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = str(limit)
        result = self._client.get("/v1/directory/agents", query or None)
        return [DirectoryAgent.model_validate(a) for a in result]

    def get_directory_agent(self, slug: str) -> DirectoryAgent:
        result = self._client.get(f"/v1/directory/agents/{_enc(slug)}")
        return DirectoryAgent.model_validate(result)

    def update_directory_agent(self, slug: str, data: UpdateDirectoryAgentRequest) -> DirectoryAgent:
        result = self._client.patch(f"/v1/directory/agents/{_enc(slug)}", data.model_dump(exclude_none=True))
        return DirectoryAgent.model_validate(result)

    def delete_directory_agent(self, slug: str) -> None:
        self._client.delete(f"/v1/directory/agents/{_enc(slug)}")

    def list_directory_ratings(self, slug: str) -> list[DirectoryRating]:
        result = self._client.get(f"/v1/directory/agents/{_enc(slug)}/ratings")
        return [DirectoryRating.model_validate(r) for r in result]

    def rate_directory_agent(self, slug: str, data: RateDirectoryAgentRequest) -> DirectoryRating:
        result = self._client.post(f"/v1/directory/agents/{_enc(slug)}/ratings", data.model_dump(exclude_none=True))
        return DirectoryRating.model_validate(result)

    def get_routing_config(self) -> RoutingConfig:
        result = self._client.get("/v1/routing/config")
        return RoutingConfig.model_validate(result)

    def update_routing_config(self, data: UpdateRoutingConfigRequest) -> RoutingConfig:
        result = self._client.put("/v1/routing/config", data.model_dump(exclude_none=True))
        return RoutingConfig.model_validate(result)

    def as_agent(self, agent_token: str) -> AgentClient:
        agent_client = HttpClient(
            agent_token,
            self._client.base_url,
            origin_client=self._client.origin_client,
            origin_version=self._client.origin_version,
            agent_relay_distinct_id=self._client.agent_relay_distinct_id,
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

    async def update(
        self, *, name: str | None = None, system_prompt: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> Workspace:
        """Update workspace fields; metadata shallow-merges, with null values deleting keys."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if metadata is not None:
            body["metadata"] = metadata
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
        recovery_proof_hash: str | None = None,
        work_unit_id: str | None = None,
    ) -> CreateAgentResponse:
        data = CreateAgentRequest(
            name=name,
            type=type,  # type: ignore[arg-type]
            persona=persona,
            metadata=metadata,
            recovery_proof_hash=recovery_proof_hash,
            work_unit_id=work_unit_id,
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
        recovery_proof_hash: str | None = None,
        work_unit_id: str | None = None,
    ) -> CreateAgentResponse:
        """Deprecated create-only alias; collisions fail closed."""
        return await self.register(
            name,
            type=type,
            persona=persona,
            metadata=metadata,
            recovery_proof_hash=recovery_proof_hash,
            work_unit_id=work_unit_id,
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

    async def rotate_token(self, name: str, *, agent_token: str) -> TokenRotateResponse:
        async with self._client.with_api_key(agent_token) as client:
            result = await client.post(f"/v1/agents/{_enc(name)}/rotate-token", {})
        return TokenRotateResponse.model_validate(result)

    async def recover(
        self,
        name: str,
        *,
        expected_agent_id: str,
        recovery_proof: str | None = None,
        reason: str | None = None,
        session_ref: str | None = None,
        node_id: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "expected_agent_id": expected_agent_id,
            "recovery_proof": recovery_proof,
            "reason": reason,
            "session_ref": session_ref,
            "node_id": node_id,
        }
        return await self._client.post(
            f"/v1/agents/{_enc(name)}/recover",
            {key: value for key, value in body.items() if value is not None},
        )

    async def take_over(
        self,
        name: str,
        *,
        expected_agent_id: str,
        actor: str,
        reason: str,
        session_ref: str,
        node_id: str,
    ) -> dict[str, Any]:
        return await self._client.post(f"/v1/agents/{_enc(name)}/takeover", {
            "expected_agent_id": expected_agent_id,
            "actor": actor,
            "reason": reason,
            "session_ref": session_ref,
            "node_id": node_id,
        })

    async def revoke_token(
        self,
        name: str,
        *,
        expected_agent_id: str,
        actor: str,
        reason: str,
        session_ref: str | None = None,
        node_id: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "expected_agent_id": expected_agent_id,
            "actor": actor,
            "reason": reason,
            "session_ref": session_ref,
            "node_id": node_id,
        }
        return await self._client.post(
            f"/v1/agents/{_enc(name)}/revoke-token",
            {key: value for key, value in body.items() if value is not None},
        )

    async def enroll_recovery_credential(
        self,
        *,
        agent_token: str,
        recovery_proof_hash: str,
        work_unit_id: str | None = None,
    ) -> dict[str, Any]:
        body = {"recovery_proof_hash": recovery_proof_hash, "work_unit_id": work_unit_id}
        async with self._client.with_api_key(agent_token) as client:
            return await client.post(
                "/v1/agent/recovery-credential",
                {key: value for key, value in body.items() if value is not None},
            )

    async def delete(self, name: str) -> None:
        await self._client.delete(f"/v1/agents/{_enc(name)}")

    # Alias for TS SDK compat
    unregister = delete


class _AsyncNodesNamespace:
    """Async node operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def create(
        self,
        data: CreateNodeRequest,
        *,
        current_token: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateNodeResponse:
        if idempotency_key is not None and current_token is None:
            raise ValueError("idempotency_key requires current_token for node rotation recovery")
        headers = {
            **({"X-Relaycast-Node-Token": current_token} if current_token is not None else {}),
            **({"Idempotency-Key": idempotency_key} if idempotency_key is not None else {}),
        }
        result = await self._client.post(
            "/v1/nodes",
            data.model_dump(exclude_none=True),
            headers=headers or None,
            retry=idempotency_key is not None,
        )
        return CreateNodeResponse.model_validate(result)

    async def list(self, *, capability: str | None = None, name: str | None = None) -> list[NodeRosterEntry]:
        query: dict[str, str] = {}
        if capability:
            query["capability"] = capability
        if name:
            query["name"] = name
        result = await self._client.get("/v1/nodes", query or None)
        return [NodeRosterEntry.model_validate(node) for node in result]

    async def get(self, name: str) -> NodeRosterEntry:
        result = await self._client.get(f"/v1/nodes/{_enc(name)}")
        return NodeRosterEntry.model_validate(result)

    async def list_agents(self, name: str) -> list[NodeAgentBinding]:
        result = await self._client.get(f"/v1/nodes/{_enc(name)}/agents")
        return [NodeAgentBinding.model_validate(binding) for binding in result]

    async def bind_agent(self, name: str, data: BindAgentToNodeRequest) -> NodeAgentBinding:
        result = await self._client.post(f"/v1/nodes/{_enc(name)}/agents", data.model_dump(exclude_none=True))
        return NodeAgentBinding.model_validate(result)

    async def unbind_agent(self, name: str, agent_name: str) -> None:
        await self._client.delete(f"/v1/nodes/{_enc(name)}/agents/{_enc(agent_name)}")


class _AsyncObserverTokensNamespace:
    """Async observer-token operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def create(self, data: CreateObserverTokenRequest) -> ObserverToken:
        result = await self._client.post("/v1/observer-tokens", data.model_dump(exclude_none=True))
        return ObserverToken.model_validate(result)

    async def list(self) -> list[ObserverToken]:
        result = await self._client.get("/v1/observer-tokens")
        return [ObserverToken.model_validate(token) for token in result]

    async def get(self, token_id: str) -> ObserverToken:
        result = await self._client.get(f"/v1/observer-tokens/{_enc(token_id)}")
        return ObserverToken.model_validate(result)

    async def update(self, token_id: str, data: UpdateObserverTokenRequest) -> ObserverToken:
        result = await self._client.patch(f"/v1/observer-tokens/{_enc(token_id)}", data.model_dump(exclude_none=True))
        return ObserverToken.model_validate(result)

    async def rotate(self, token_id: str) -> ObserverToken:
        result = await self._client.post(f"/v1/observer-tokens/{_enc(token_id)}/rotate", {})
        return ObserverToken.model_validate(result)

    async def revoke(self, token_id: str) -> None:
        await self._client.delete(f"/v1/observer-tokens/{_enc(token_id)}")


class AsyncRelay:
    """Asynchronous Relay client.

    Usage::

        async with AsyncRelay(api_key="rk_live_xxx") as relay:
            agent = await relay.agents.register(name="Coder", persona="Senior developer")
            me = relay.as_agent(agent.token)
            await me.send("#general", "Hello from Python")
    """

    @staticmethod
    async def create_workspace(
        name: str, *, metadata: dict[str, Any] | None = None,
        api_key: str | None = None, base_url: str | None = None,
        idempotency_key: str | None = None,
    ) -> CreateWorkspaceResponse:
        """Create a workspace; automatic retries require an idempotency key.

        Anonymous keys are reveal-once recovery capabilities: generate with a
        CSPRNG (for example uuid.uuid4()), and retain the key for safe retries.
        An owner api_key scopes delegated keys to that owner.
        """
        headers = _workspace_create_headers(idempotency_key, api_key, base_url)
        data = CreateWorkspaceRequest(name=name, metadata=metadata)
        async with AsyncHttpClient(api_key or "", base_url) as client:
            result = await client.request(
                "POST", "/v1/workspaces", data.model_dump(exclude_none=True),
                headers=headers, retry=idempotency_key is not None,
            )
        return CreateWorkspaceResponse.model_validate(result)

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_distinct_id: str | None = None,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("Relay api_key is required")

        self._client = AsyncHttpClient(
            api_key,
            base_url,
            origin_client=origin_client,
            origin_version=origin_version,
            agent_relay_distinct_id=agent_relay_distinct_id,
        )
        self.workspace = _AsyncWorkspaceNamespace(self._client)
        self.agents = _AsyncAgentsNamespace(self._client)
        self.nodes = _AsyncNodesNamespace(self._client)
        self.observer_tokens = _AsyncObserverTokensNamespace(self._client)


    async def register_agent(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
        recovery_proof_hash: str | None = None,
        work_unit_id: str | None = None,
    ) -> CreateAgentResponse:
        return await self.agents.register(
            name,
            type=type,
            persona=persona,
            metadata=metadata,
            recovery_proof_hash=recovery_proof_hash,
            work_unit_id=work_unit_id,
        )

    async def register_or_rotate(
        self,
        name: str,
        *,
        type: str | None = None,
        persona: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CreateAgentResponse:
        return await self.agents.register_or_rotate(name, type=type, persona=persona, metadata=metadata)

    async def agent(self, name: str, *, persona: str | None = None, metadata: dict[str, Any] | None = None) -> CreateAgentResponse:
        return await self.register_agent(name, type="agent", persona=persona, metadata=metadata)

    async def human(self, name: str, *, persona: str | None = None, metadata: dict[str, Any] | None = None) -> CreateAgentResponse:
        return await self.register_agent(name, type="human", persona=persona, metadata=metadata)

    async def system(self, name: str, *, persona: str | None = None, metadata: dict[str, Any] | None = None) -> CreateAgentResponse:
        return await self.register_agent(name, type="system", persona=persona, metadata=metadata)

    async def register_a2a(self, options: RegisterA2aOptions) -> RegisterA2aResponse:
        result = await self._client.post("/v1/a2a/register", options.model_dump(exclude_none=True))
        return RegisterA2aResponse.model_validate(result)

    async def list_a2a_agents(self) -> list[A2aAgentRecord]:
        result = await self._client.get("/v1/a2a/agents")
        return [A2aAgentRecord.model_validate(a) for a in result]

    async def remove_a2a_agent(self, name: str) -> RemoveA2aAgentResponse:
        result = await self._client.request("DELETE", f"/v1/a2a/agents/{_enc(name)}")
        return RemoveA2aAgentResponse.model_validate(result)

    async def get_a2a_agent_card(self, name: str) -> A2aAgentCard:
        result = await self._client.get(f"/v1/a2a/agents/{_enc(name)}/card")
        return A2aAgentCard.model_validate(result)

    async def route(self, skill: str, message: str | None = None) -> RouteResult:
        result = await self._client.post("/v1/route", {"skill": skill, "message": message})
        return RouteResult.model_validate(result)

    async def search_directory(
        self, *, q: str | None = None, tags: list[str] | None = None, status: str | None = None, limit: int | None = None
    ) -> list[DirectorySearchResult]:
        query: dict[str, str] = {}
        if q:
            query["q"] = q
        if tags:
            query["tags"] = ",".join(tags)
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = str(limit)
        result = await self._client.get("/v1/directory/search", query or None)
        return [DirectorySearchResult.model_validate(a) for a in result]

    async def publish_to_directory(self, data: PublishToDirectoryRequest) -> DirectoryAgent:
        result = await self._client.post("/v1/directory/agents", data.model_dump(exclude_none=True))
        return DirectoryAgent.model_validate(result)

    async def import_skills(self, data: ImportSkillsRequest) -> DirectoryAgent | None:
        result = await self._client.post("/v1/skills/sync", data.model_dump(exclude_none=True))
        return DirectoryAgent.model_validate(result) if result is not None else None

    async def search_skills(self, *, q: str | None = None, limit: int | None = None) -> list[SkillSearchResult]:
        query: dict[str, str] = {}
        if q:
            query["q"] = q
        if limit is not None:
            query["limit"] = str(limit)
        result = await self._client.get("/v1/skills/search", query or None)
        return [SkillSearchResult.model_validate(s) for s in result]

    async def route_feedback(self, data: RouteFeedbackRequest) -> RouteFeedbackResult:
        result = await self._client.post("/v1/route/feedback", data.model_dump(exclude_none=True))
        return RouteFeedbackResult.model_validate(result)

    async def list_directory(self, *, status: str | None = None, limit: int | None = None) -> list[DirectoryAgent]:
        query: dict[str, str] = {}
        if status:
            query["status"] = status
        if limit is not None:
            query["limit"] = str(limit)
        result = await self._client.get("/v1/directory/agents", query or None)
        return [DirectoryAgent.model_validate(a) for a in result]

    async def get_directory_agent(self, slug: str) -> DirectoryAgent:
        result = await self._client.get(f"/v1/directory/agents/{_enc(slug)}")
        return DirectoryAgent.model_validate(result)

    async def update_directory_agent(self, slug: str, data: UpdateDirectoryAgentRequest) -> DirectoryAgent:
        result = await self._client.patch(f"/v1/directory/agents/{_enc(slug)}", data.model_dump(exclude_none=True))
        return DirectoryAgent.model_validate(result)

    async def delete_directory_agent(self, slug: str) -> None:
        await self._client.delete(f"/v1/directory/agents/{_enc(slug)}")

    async def list_directory_ratings(self, slug: str) -> list[DirectoryRating]:
        result = await self._client.get(f"/v1/directory/agents/{_enc(slug)}/ratings")
        return [DirectoryRating.model_validate(r) for r in result]

    async def rate_directory_agent(self, slug: str, data: RateDirectoryAgentRequest) -> DirectoryRating:
        result = await self._client.post(f"/v1/directory/agents/{_enc(slug)}/ratings", data.model_dump(exclude_none=True))
        return DirectoryRating.model_validate(result)

    async def get_routing_config(self) -> RoutingConfig:
        result = await self._client.get("/v1/routing/config")
        return RoutingConfig.model_validate(result)

    async def update_routing_config(self, data: UpdateRoutingConfigRequest) -> RoutingConfig:
        result = await self._client.put("/v1/routing/config", data.model_dump(exclude_none=True))
        return RoutingConfig.model_validate(result)

    def as_agent(self, agent_token: str) -> AsyncAgentClient:
        agent_client = AsyncHttpClient(
            agent_token,
            self._client.base_url,
            origin_client=self._client.origin_client,
            origin_version=self._client.origin_version,
            agent_relay_distinct_id=self._client.agent_relay_distinct_id,
        )
        return AsyncAgentClient(agent_client)

    as_ = as_agent

    async def close(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> AsyncRelay:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
