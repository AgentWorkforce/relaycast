"""HTTP client with retry logic for the Relay API."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlencode

import httpx

from .errors import RelayError

SDK_VERSION = "0.1.0"

_DEFAULT_BASE_URL = "https://api.agentrelay.dev"
_RETRY_BACKOFFS = [0.2, 0.4, 0.8]


class HttpClient:
    """Synchronous HTTP client for the Relay REST API."""

    def __init__(self, api_key: str, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self._client = httpx.Client(timeout=30.0)

    def _headers(self, with_body: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "X-SDK-Version": SDK_VERSION,
        }
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

    def __init__(self, api_key: str, base_url: str | None = None) -> None:
        self.api_key = api_key
        self.base_url = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self._client = httpx.AsyncClient(timeout=30.0)

    def _headers(self, with_body: bool = False) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "X-SDK-Version": SDK_VERSION,
        }
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

    async def delete(self, path: str) -> None:
        await self.request("DELETE", path)

    async def close(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncHttpClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
