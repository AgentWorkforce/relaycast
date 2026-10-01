"""Workspace metadata round trips through sync and async public clients."""
import json

import httpx
import pytest
import respx

from relay_sdk import Relay, AsyncRelay
from relay_sdk.errors import RelayError
from relay_sdk.models import CreateWorkspaceRequest, UpdateWorkspaceRequest, Workspace

BASE = "https://test.relay.dev"
KEY = "rk_test_workspace"
METADATA = {"project_id": "p1", "nested": {"camelKey": None}, "list": [False, 3]}
# Exact public field shape returned by engine/workspace.ts getWorkspace (also PATCH).
WORKSPACE = {
    "id": "ws_1", "name": "Test", "plan": "free", "system_prompt": None,
    "created_at": "2026-10-01T00:00:00.000Z", "metadata": METADATA,
    "effective_retention": {"messages": {
        "policy": "unknown", "message_ttl_days": None, "retained_since": None,
        "source": "unknown", "reason": "boundary_unavailable",
    }},
    "expires_at": None, "provenance": None, "usage_classification": "unclassified",
    "classification_source": None, "classification_reason": None, "classified_at": None,
}
CREATED = {"workspace_id": "ws_1", "api_key": KEY, "created_at": "2026-10-01"}


def ok(data):
    return httpx.Response(200, json={"ok": True, "data": data})


@pytest.mark.parametrize("model", [CreateWorkspaceRequest, UpdateWorkspaceRequest])
def test_request_models_preserve_metadata(model):
    assert model(name="Test", metadata=METADATA).model_dump(exclude_none=True)["metadata"] == METADATA
    assert "metadata" not in model(name="Test").model_dump(exclude_none=True)


@pytest.mark.parametrize("metadata", [None, {}, METADATA])
@pytest.mark.parametrize("api_key", [None, KEY])
@respx.mock
def test_sync_create(metadata, api_key):
    route = respx.post(f"{BASE}/v1/workspaces").mock(return_value=ok(CREATED))
    result = Relay.create_workspace("Test", metadata=metadata, api_key=api_key, base_url=BASE)
    assert result.workspace_id == "ws_1"
    request = route.calls.last.request
    assert json.loads(request.content) == {"name": "Test", **({"metadata": metadata} if metadata is not None else {})}
    assert request.headers.get("Authorization") == (f"Bearer {api_key}" if api_key else None)


@pytest.mark.parametrize("metadata", [None, {}, METADATA])
@pytest.mark.parametrize("api_key", [None, KEY])
@respx.mock
async def test_async_create(metadata, api_key):
    route = respx.post(f"{BASE}/v1/workspaces").mock(return_value=ok(CREATED))
    result = await AsyncRelay.create_workspace("Test", metadata=metadata, api_key=api_key, base_url=BASE)
    assert result.workspace_id == "ws_1"
    request = route.calls.last.request
    assert json.loads(request.content) == {"name": "Test", **({"metadata": metadata} if metadata is not None else {})}
    assert request.headers.get("Authorization") == (f"Bearer {api_key}" if api_key else None)


@respx.mock
def test_sync_info_update():
    respx.get(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE))
    route = respx.patch(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE))
    with Relay(KEY, base_url=BASE) as relay:
        workspace = relay.workspace.info()
        assert workspace.metadata == METADATA
        assert workspace.api_key_hash is None
        patch = {"project_id": None, "nested": {"child": None}}
        assert relay.workspace.update(metadata=patch).metadata == METADATA
        assert json.loads(route.calls.last.request.content) == {"metadata": patch}
        relay.workspace.update(name="Renamed")
        assert json.loads(route.calls.last.request.content) == {"name": "Renamed"}
        relay.workspace.update(metadata={})
        assert json.loads(route.calls.last.request.content) == {"metadata": {}}


@respx.mock
async def test_async_info_update():
    respx.get(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE))
    route = respx.patch(f"{BASE}/v1/workspace").mock(return_value=ok(WORKSPACE))
    async with AsyncRelay(KEY, base_url=BASE) as relay:
        workspace = await relay.workspace.info()
        assert workspace.metadata == METADATA
        assert workspace.api_key_hash is None
        patch = {"project_id": None, "nested": {"child": None}}
        assert (await relay.workspace.update(metadata=patch)).metadata == METADATA
        assert json.loads(route.calls.last.request.content) == {"metadata": patch}
        await relay.workspace.update(name="Renamed")
        assert json.loads(route.calls.last.request.content) == {"name": "Renamed"}
        await relay.workspace.update(metadata={})
        assert json.loads(route.calls.last.request.content) == {"metadata": {}}


def test_workspace_legacy_hash_remains_accepted():
    assert Workspace.model_validate({**WORKSPACE, "api_key_hash": "legacy"}).api_key_hash == "legacy"


FAILURE = httpx.Response(503, json={"ok": False, "error": {"code": "unavailable", "message": "Unavailable"}})
RETRY_KEY = "99c2c745-747a-4c35-ab8d-fca9a290b2b1"


@respx.mock
def test_sync_create_without_key_does_not_retry():
    route = respx.post(f"{BASE}/v1/workspaces").mock(side_effect=[FAILURE, ok(CREATED)])
    with pytest.raises(RelayError, match="Unavailable"):
        Relay.create_workspace("Test", base_url=BASE)
    assert route.call_count == 1
    assert "Idempotency-Key" not in route.calls.last.request.headers


@respx.mock
async def test_async_create_without_key_does_not_retry():
    route = respx.post(f"{BASE}/v1/workspaces").mock(side_effect=[FAILURE, ok(CREATED)])
    with pytest.raises(RelayError, match="Unavailable"):
        await AsyncRelay.create_workspace("Test", base_url=BASE)
    assert route.call_count == 1
    assert "Idempotency-Key" not in route.calls.last.request.headers


@pytest.mark.parametrize("api_key", [None, KEY])
@respx.mock
def test_sync_keyed_create_retries_with_identical_key_and_body(api_key):
    route = respx.post(f"{BASE}/v1/workspaces").mock(side_effect=[FAILURE, ok(CREATED)])
    created = Relay.create_workspace("Test", metadata=METADATA, api_key=api_key, base_url=BASE, idempotency_key=RETRY_KEY)
    assert created.workspace_id == "ws_1"
    assert route.call_count == 2
    for call in route.calls:
        assert call.request.headers["Idempotency-Key"] == RETRY_KEY
        assert json.loads(call.request.content) == {"name": "Test", "metadata": METADATA}


@pytest.mark.parametrize("api_key", [None, KEY])
@respx.mock
async def test_async_keyed_create_retries_with_identical_key_and_body(api_key):
    route = respx.post(f"{BASE}/v1/workspaces").mock(side_effect=[FAILURE, ok(CREATED)])
    created = await AsyncRelay.create_workspace("Test", metadata=METADATA, api_key=api_key, base_url=BASE, idempotency_key=RETRY_KEY)
    assert created.workspace_id == "ws_1"
    assert route.call_count == 2
    for call in route.calls:
        assert call.request.headers["Idempotency-Key"] == RETRY_KEY
        assert json.loads(call.request.content) == {"name": "Test", "metadata": METADATA}


@pytest.mark.parametrize("kwargs", [
    {"idempotency_key": "short"},
    {"idempotency_key": RETRY_KEY, "base_url": "http://remote.test"},
    {"idempotency_key": ""},
])
@respx.mock
def test_sync_rejects_unsafe_keys_before_request(kwargs):
    with pytest.raises(ValueError):
        Relay.create_workspace("Test", **kwargs)
    assert not respx.calls


@pytest.mark.parametrize("kwargs", [
    {"idempotency_key": "short"},
    {"idempotency_key": RETRY_KEY, "base_url": "http://remote.test"},
    {"idempotency_key": ""},
])
@respx.mock
async def test_async_rejects_unsafe_keys_before_request(kwargs):
    with pytest.raises(ValueError):
        await AsyncRelay.create_workspace("Test", **kwargs)
    assert not respx.calls
