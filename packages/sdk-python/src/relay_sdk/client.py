"""HTTP client with retry logic for the Relay API."""

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import urlencode

import httpx

from .errors import RelayError

SDK_VERSION = "0.3.0"
AGENT_RELAY_DISTINCT_ID_HEADER = "X-Agent-Relay-Distinct-Id"
AGENT_RELAY_DISTINCT_ID_QUERY = "agent_relay_distinct_id"

_DEFAULT_BASE_URL = "https://cast.agentrelay.com"
_RETRY_BACKOFFS = [0.2, 0.4, 0.8]
_DEFAULT_ORIGIN_CLIENT = "@relaycast/python-sdk"
_AGENT_RELAY_DISTINCT_ID_ALLOWED = re.compile(r"^[a-z0-9._:-]+$", re.IGNORECASE)


def sanitize_agent_relay_distinct_id(raw: str | None) -> str | None:
    """Return a sanitized Agent Relay distinct id, or None when invalid."""
    if not raw:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    if not _AGENT_RELAY_DISTINCT_ID_ALLOWED.fullmatch(trimmed):
        return None
    return trimmed[:128]


class HttpClient:
    """Synchronous HTTP client for the Relay REST API."""

    def __init__(
        self,
        api_key: str,
        base_url: str | None = None,
        *,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_distinct_id: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self.origin_client = (origin_client or _DEFAULT_ORIGIN_CLIENT).strip()[:80]
        self.origin_version = (origin_version or SDK_VERSION).strip()[:48]
        self.agent_relay_distinct_id = sanitize_agent_relay_distinct_id(agent_relay_distinct_id)
        self._client = httpx.Client(timeout=30.0)

    def _headers(self, with_body: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "X-SDK-Version": SDK_VERSION,
            "X-Relaycast-Origin-Client": self.origin_client,
            "X-Relaycast-Origin-Version": self.origin_version,
        }
        if self.agent_relay_distinct_id:
            headers[AGENT_RELAY_DISTINCT_ID_HEADER] = self.agent_relay_distinct_id
        if with_body:
            headers["Content-Type"] = "application/json"
        return headers

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: dict[str, str] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            filtered = {k: v for k, v in query.items() if v is not None}
            if filtered:
                url = f"{url}?{urlencode(filtered)}"

        has_body = body is not None and method.upper() != "GET"
        headers = self._headers(with_body=has_body)

        for attempt in range(len(_RETRY_BACKOFFS) + 1):
            response = self._client.request(
                method,
                url,
                headers=headers,
                json=body if has_body else None,
            )

            if 500 <= response.status_code <= 599 and attempt < len(_RETRY_BACKOFFS):
                import time
                time.sleep(_RETRY_BACKOFFS[attempt])
                continue

            return self._handle_response(response)

    def _handle_response(self, response: httpx.Response) -> Any:
        # Empty / no-content responses (e.g. 204 from DELETE) have no JSON body.
        if response.status_code == 204 or not response.content:
            if response.is_success:
                return None
            raise RelayError("invalid_response", "Invalid API response", response.status_code)

        parsed = response.json()

        if not isinstance(parsed, dict) or "ok" not in parsed:
            raise RelayError("invalid_response", "Invalid API response", response.status_code)

        if not parsed["ok"]:
            error = parsed.get("error", {})
            code = error.get("code", "unknown_error")
            message = error.get("message", "Unknown error")
            raise RelayError(code, message, response.status_code)

        return parsed.get("data")

    def get(self, path: str, query: dict[str, str] | None = None) -> Any:
        return self.request("GET", path, query=query)

    def post(self, path: str, body: Any = None) -> Any:
        return self.request("POST", path, body=body)

    def patch(self, path: str, body: Any = None) -> Any:
        return self.request("PATCH", path, body=body)

    def put(self, path: str, body: Any = None) -> Any:
        return self.request("PUT", path, body=body)

    def delete(self, path: str) -> None:
        self.request("DELETE", path)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HttpClient:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


class AsyncHttpClient:
    """Asynchronous HTTP client for the Relay REST API."""

    def __init__(
        self,
        api_key: str,
        base_url: str | None = None,
        *,
        origin_client: str | None = None,
        origin_version: str | None = None,
        agent_relay_distinct_id: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self.origin_client = (origin_client or _DEFAULT_ORIGIN_CLIENT).strip()[:80]
        self.origin_version = (origin_version or SDK_VERSION).strip()[:48]
        self.agent_relay_distinct_id = sanitize_agent_relay_distinct_id(agent_relay_distinct_id)
        self._client = httpx.AsyncClient(timeout=30.0)

    def _headers(self, with_body: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "X-SDK-Version": SDK_VERSION,
            "X-Relaycast-Origin-Client": self.origin_client,
            "X-Relaycast-Origin-Version": self.origin_version,
        }
        if self.agent_relay_distinct_id:
            headers[AGENT_RELAY_DISTINCT_ID_HEADER] = self.agent_relay_distinct_id
        if with_body:
            headers["Content-Type"] = "application/json"
        return headers

    async def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: dict[str, str] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if query:
            filtered = {k: v for k, v in query.items() if v is not None}
            if filtered:
                url = f"{url}?{urlencode(filtered)}"

        has_body = body is not None and method.upper() != "GET"
        headers = self._headers(with_body=has_body)

        for attempt in range(len(_RETRY_BACKOFFS) + 1):
            response = await self._client.request(
                method,
                url,
                headers=headers,
                json=body if has_body else None,
            )

            if 500 <= response.status_code <= 599 and attempt < len(_RETRY_BACKOFFS):
                await asyncio.sleep(_RETRY_BACKOFFS[attempt])
                continue

            return self._handle_response(response)

    def _handle_response(self, response: httpx.Response) -> Any:
        # Empty / no-content responses (e.g. 204 from DELETE) have no JSON body.
        if response.status_code == 204 or not response.content:
            if response.is_success:
                return None
            raise RelayError("invalid_response", "Invalid API response", response.status_code)

        parsed = response.json()

        if not isinstance(parsed, dict) or "ok" not in parsed:
            raise RelayError("invalid_response", "Invalid API response", response.status_code)

        if not parsed["ok"]:
            error = parsed.get("error", {})
            code = error.get("code", "unknown_error")
            message = error.get("message", "Unknown error")
            raise RelayError(code, message, response.status_code)

        return parsed.get("data")

    async def get(self, path: str, query: dict[str, str] | None = None) -> Any:
        return await self.request("GET", path, query=query)

    async def post(self, path: str, body: Any = None) -> Any:
        return await self.request("POST", path, body=body)

    async def patch(self, path: str, body: Any = None) -> Any:
        return await self.request("PATCH", path, body=body)

    async def put(self, path: str, body: Any = None) -> Any:
        return await self.request("PUT", path, body=body)

    async def delete(self, path: str) -> None:
        await self.request("DELETE", path)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncHttpClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
