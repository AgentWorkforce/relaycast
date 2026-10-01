"""Workspace metadata round trips through sync and async public clients."""
import json

import httpx
import pytest
import respx

from relay_sdk import Relay, AsyncRelay
from relay_sdk.models import CreateWorkspaceRequest, UpdateWorkspaceRequest

BASE = "https://test.relay.dev"
KEY = "rk_test_workspace"
METADATA = {"project_id": "p1", "nested": {"camelKey": None}, "list": [False, 3]}
WORKSPACE = {"id": "ws_1", "name": "Test", "api_key_hash": "hash", "created_at": "2026-10-01", "metadata": METADATA}
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
        assert relay.workspace.info().metadata == METADATA
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
        assert (await relay.workspace.info()).metadata == METADATA
        patch = {"project_id": None, "nested": {"child": None}}
        assert (await relay.workspace.update(metadata=patch)).metadata == METADATA
        assert json.loads(route.calls.last.request.content) == {"metadata": patch}
        await relay.workspace.update(name="Renamed")
        assert json.loads(route.calls.last.request.content) == {"name": "Renamed"}
        await relay.workspace.update(metadata={})
        assert json.loads(route.calls.last.request.content) == {"metadata": {}}
