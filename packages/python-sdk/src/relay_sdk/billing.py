"""Billing client for the Relay API."""

from __future__ import annotations

from typing import Any

from .client import AsyncHttpClient, HttpClient
from .models import BillingSubscription, PortalResponse, SubscribeRequest, UsageInfo


class BillingClient:
    """Synchronous billing operations."""

    def __init__(self, client: HttpClient) -> None:
        self._client = client

    def subscribe(self, plan: str, payment_method: str) -> BillingSubscription:
        data = SubscribeRequest(plan=plan, payment_method=payment_method)  # type: ignore[arg-type]
        result = self._client.post("/v1/billing/subscribe", data.model_dump())
        return BillingSubscription.model_validate(result)

    def subscription(self) -> BillingSubscription:
        result = self._client.get("/v1/billing/subscription")
        return BillingSubscription.model_validate(result)

    def usage(self, period: str | None = None) -> UsageInfo:
        query: dict[str, str] = {}
        if period:
            query["period"] = period
        result = self._client.get("/v1/billing/usage", query or None)
        return UsageInfo.model_validate(result)

    def invoices(self, limit: int | None = None) -> list[Any]:
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        return self._client.get("/v1/billing/invoices", query or None)

    def portal(self) -> PortalResponse:
        result = self._client.post("/v1/billing/portal")
        return PortalResponse.model_validate(result)


class AsyncBillingClient:
    """Asynchronous billing operations."""

    def __init__(self, client: AsyncHttpClient) -> None:
        self._client = client

    async def subscribe(self, plan: str, payment_method: str) -> BillingSubscription:
        data = SubscribeRequest(plan=plan, payment_method=payment_method)  # type: ignore[arg-type]
        result = await self._client.post("/v1/billing/subscribe", data.model_dump())
        return BillingSubscription.model_validate(result)

    async def subscription(self) -> BillingSubscription:
        result = await self._client.get("/v1/billing/subscription")
        return BillingSubscription.model_validate(result)

    async def usage(self, period: str | None = None) -> UsageInfo:
        query: dict[str, str] = {}
        if period:
            query["period"] = period
        result = await self._client.get("/v1/billing/usage", query or None)
        return UsageInfo.model_validate(result)

    async def invoices(self, limit: int | None = None) -> list[Any]:
        query: dict[str, str] = {}
        if limit:
            query["limit"] = str(limit)
        return await self._client.get("/v1/billing/invoices", query or None)

    async def portal(self) -> PortalResponse:
        result = await self._client.post("/v1/billing/portal")
        return PortalResponse.model_validate(result)
