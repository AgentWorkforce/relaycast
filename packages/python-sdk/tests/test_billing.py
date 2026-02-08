"""Tests for BillingClient and AsyncBillingClient."""

import httpx
import pytest
import respx

from relay_sdk.billing import AsyncBillingClient, BillingClient
from relay_sdk.client import AsyncHttpClient, HttpClient
from relay_sdk.models import BillingSubscription, PortalResponse, UsageInfo

BASE = "https://test.relay.dev"
KEY = "rk_test_abc"


def ok(data):
    return httpx.Response(200, json={"ok": True, "data": data})


SUB_DATA = {
    "subscription_id": "sub_1",
    "plan": "pro",
    "status": "active",
    "current_period_end": "2025-02-01T00:00:00Z",
}

USAGE_DATA = {
    "messages_sent": 100,
    "messages_stored": 90,
    "files_uploaded": 5,
    "file_storage_bytes": 1024,
    "agents_registered": 3,
    "api_calls": 500,
    "websocket_minutes": 60,
    "period_start": "2025-01-01T00:00:00Z",
    "period_end": "2025-02-01T00:00:00Z",
}


class TestBillingClient:
    @respx.mock
    def test_subscribe(self):
        route = respx.post(f"{BASE}/v1/billing/subscribe").mock(return_value=ok(SUB_DATA))
        bc = BillingClient(HttpClient(KEY, BASE))
        result = bc.subscribe("pro", "pm_xxx")
        assert isinstance(result, BillingSubscription)
        assert result.plan == "pro"
        assert route.called

    @respx.mock
    def test_subscription(self):
        respx.get(f"{BASE}/v1/billing/subscription").mock(return_value=ok(SUB_DATA))
        bc = BillingClient(HttpClient(KEY, BASE))
        result = bc.subscription()
        assert result.status == "active"

    @respx.mock
    def test_usage(self):
        respx.get(f"{BASE}/v1/billing/usage").mock(return_value=ok(USAGE_DATA))
        bc = BillingClient(HttpClient(KEY, BASE))
        result = bc.usage()
        assert isinstance(result, UsageInfo)
        assert result.messages_sent == 100

    @respx.mock
    def test_usage_with_period(self):
        route = respx.get(f"{BASE}/v1/billing/usage").mock(return_value=ok(USAGE_DATA))
        bc = BillingClient(HttpClient(KEY, BASE))
        bc.usage("previous")
        req = route.calls[0].request
        assert "period=previous" in str(req.url)

    @respx.mock
    def test_invoices(self):
        respx.get(f"{BASE}/v1/billing/invoices").mock(return_value=ok([{"id": "inv_1"}]))
        bc = BillingClient(HttpClient(KEY, BASE))
        result = bc.invoices(limit=5)
        assert len(result) == 1

    @respx.mock
    def test_portal(self):
        respx.post(f"{BASE}/v1/billing/portal").mock(return_value=ok({"url": "https://stripe.com/portal"}))
        bc = BillingClient(HttpClient(KEY, BASE))
        result = bc.portal()
        assert isinstance(result, PortalResponse)
        assert result.url.startswith("https://")


class TestAsyncBillingClient:
    @pytest.mark.asyncio
    @respx.mock
    async def test_subscribe(self):
        respx.post(f"{BASE}/v1/billing/subscribe").mock(return_value=ok(SUB_DATA))
        bc = AsyncBillingClient(AsyncHttpClient(KEY, BASE))
        result = await bc.subscribe("pro", "pm_xxx")
        assert result.plan == "pro"

    @pytest.mark.asyncio
    @respx.mock
    async def test_subscription(self):
        respx.get(f"{BASE}/v1/billing/subscription").mock(return_value=ok(SUB_DATA))
        bc = AsyncBillingClient(AsyncHttpClient(KEY, BASE))
        result = await bc.subscription()
        assert result.status == "active"

    @pytest.mark.asyncio
    @respx.mock
    async def test_usage(self):
        respx.get(f"{BASE}/v1/billing/usage").mock(return_value=ok(USAGE_DATA))
        bc = AsyncBillingClient(AsyncHttpClient(KEY, BASE))
        result = await bc.usage()
        assert result.messages_sent == 100

    @pytest.mark.asyncio
    @respx.mock
    async def test_portal(self):
        respx.post(f"{BASE}/v1/billing/portal").mock(return_value=ok({"url": "https://stripe.com/portal"}))
        bc = AsyncBillingClient(AsyncHttpClient(KEY, BASE))
        result = await bc.portal()
        assert result.url.startswith("https://")
