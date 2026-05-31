import json

import httpx
import pytest
import respx

from relay_sdk.client import AsyncHttpClient, HttpClient, SDK_VERSION
from relay_sdk.errors import RelayError

from .conftest import API_KEY, BASE_URL, error_response, ok_response


def _req_json(request: httpx.Request):
    if not request.content:
        return None
    return json.loads(request.content.decode("utf-8"))


def test_http_client_constructor_sets_api_key_and_base_url():
    c = HttpClient(api_key=API_KEY, base_url=f"{BASE_URL}/")
    assert c.api_key == API_KEY
    assert c.base_url == BASE_URL


def test_http_client_constructor_default_base_url_is_set_and_stripped():
    c = HttpClient(api_key=API_KEY)
    assert c.api_key == API_KEY
    assert c.base_url == "https://gateway.relaycast.dev"


@respx.mock
def test_http_client_get_sends_get_with_authorization_header():
    route = respx.get(f"{BASE_URL}/v1/ping").mock(
        return_value=httpx.Response(200, json=ok_response({"pong": True}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.get("/v1/ping") == {"pong": True}

    assert route.called
    req = route.calls[0].request
    assert req.method == "GET"
    assert req.headers["Authorization"] == f"Bearer {API_KEY}"


@respx.mock
def test_http_client_sends_x_sdk_version_header():
    route = respx.get(f"{BASE_URL}/v1/version").mock(
        return_value=httpx.Response(200, json=ok_response({"ok": True}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    c.get("/v1/version")

    req = route.calls[0].request
    assert req.headers["X-SDK-Version"] == SDK_VERSION
    assert req.headers["X-Relaycast-Origin-Surface"] == "sdk"
    assert req.headers["X-Relaycast-Origin-Client"] == "@relaycast/python-sdk"
    assert req.headers["X-Relaycast-Origin-Version"] == SDK_VERSION


@respx.mock
def test_http_client_post_sends_post_with_json_body_and_content_type_header():
    route = respx.post(f"{BASE_URL}/v1/things").mock(
        return_value=httpx.Response(200, json=ok_response({"id": "t1"}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.post("/v1/things", body={"name": "n"}) == {"id": "t1"}

    assert route.called
    req = route.calls[0].request
    assert req.method == "POST"
    assert req.headers["Content-Type"] == "application/json"
    assert _req_json(req) == {"name": "n"}


@respx.mock
def test_http_client_post_without_body_does_not_send_json_and_omits_content_type():
    route = respx.post(f"{BASE_URL}/v1/no-body").mock(
        return_value=httpx.Response(200, json=ok_response({"ok": True}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    c.post("/v1/no-body")

    req = route.calls[0].request
    assert req.method == "POST"
    assert "Content-Type" not in req.headers
    assert req.content in (b"", None)


@respx.mock
def test_http_client_patch_sends_patch():
    route = respx.patch(f"{BASE_URL}/v1/things/t1").mock(
        return_value=httpx.Response(200, json=ok_response({"updated": True}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.patch("/v1/things/t1", body={"name": "n2"}) == {"updated": True}

    req = route.calls[0].request
    assert req.method == "PATCH"
    assert _req_json(req) == {"name": "n2"}


@respx.mock
def test_http_client_delete_sends_delete_and_returns_none():
    route = respx.delete(f"{BASE_URL}/v1/things/t1").mock(
        return_value=httpx.Response(200, json=ok_response(None))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.delete("/v1/things/t1") is None

    req = route.calls[0].request
    assert req.method == "DELETE"
    assert req.content in (b"", None)


@respx.mock
def test_http_client_successful_response_extracts_data_field():
    route = respx.get(f"{BASE_URL}/v1/data").mock(
        return_value=httpx.Response(200, json=ok_response({"a": 1}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.get("/v1/data") == {"a": 1}
    assert route.called


@respx.mock
def test_http_client_error_response_raises_relay_error_with_code_message_status():
    respx.get(f"{BASE_URL}/v1/missing").mock(
        return_value=httpx.Response(404, json=error_response(code="not_found", message="Missing"))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    with pytest.raises(RelayError) as ei:
        c.get("/v1/missing")

    err = ei.value
    assert err.code == "not_found"
    assert str(err) == "Missing"
    assert err.status == 404


@respx.mock
def test_http_client_invalid_response_missing_ok_field_raises_relay_error():
    respx.get(f"{BASE_URL}/v1/bad").mock(return_value=httpx.Response(200, json={"data": 123}))
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    with pytest.raises(RelayError) as ei:
        c.get("/v1/bad")

    err = ei.value
    assert err.code == "invalid_response"
    assert str(err) == "Invalid API response"
    assert err.status == 200


@respx.mock
def test_http_client_query_params_are_encoded_in_url_and_none_values_are_filtered():
    # Ensure ordering is deterministic by insertion order.
    respx.get(f"{BASE_URL}/v1/search?a=1&b=two").mock(
        return_value=httpx.Response(200, json=ok_response({"hits": []}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.get("/v1/search", query={"a": "1", "b": "two", "ignored": None}) == {"hits": []}


@respx.mock
def test_http_client_get_does_not_send_body_even_if_body_is_provided_via_request():
    # `has_body` is false for GET; the client should not send JSON or Content-Type.
    route = respx.get(f"{BASE_URL}/v1/get-with-body").mock(
        return_value=httpx.Response(200, json=ok_response({"ok": True}))
    )
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.request("GET", "/v1/get-with-body", body={"ignored": True}) == {"ok": True}

    req = route.calls[0].request
    assert req.method == "GET"
    assert "Content-Type" not in req.headers
    assert req.content in (b"", None)


@respx.mock
def test_http_client_retries_5xx_up_to_3_times_then_succeeds(monkeypatch):
    import time

    sleeps: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda s: sleeps.append(s))

    route = respx.get(f"{BASE_URL}/v1/flaky").mock(
        side_effect=[
            httpx.Response(503, json=error_response(code="unavailable", message="nope")),
            httpx.Response(502, json=error_response(code="bad_gateway", message="nope")),
            httpx.Response(500, json=error_response(code="server_error", message="nope")),
            httpx.Response(200, json=ok_response({"ok": True})),
        ]
    )

    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert c.get("/v1/flaky") == {"ok": True}

    assert route.call_count == 4
    assert sleeps == [0.2, 0.4, 0.8]


@respx.mock
def test_http_client_5xx_that_never_recovers_raises_relay_error(monkeypatch):
    import time

    sleeps: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda s: sleeps.append(s))

    # Three retries on 5xx, then a final 5xx that is handled and raises.
    respx.get(f"{BASE_URL}/v1/down").mock(
        side_effect=[
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
        ]
    )

    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    with pytest.raises(RelayError) as ei:
        c.get("/v1/down")
    err = ei.value
    assert err.code == "unavailable"
    assert str(err) == "down"
    assert err.status == 503
    assert sleeps == [0.2, 0.4, 0.8]


def test_http_client_context_manager_calls_close(monkeypatch):
    c = HttpClient(api_key=API_KEY, base_url=BASE_URL)
    closed = {"called": 0}
    monkeypatch.setattr(c._client, "close", lambda: closed.__setitem__("called", closed["called"] + 1))

    with c as client:
        assert client is c

    assert closed["called"] == 1


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_get_sends_get_with_authorization_header():
    route = respx.get(f"{BASE_URL}/v1/ping").mock(
        return_value=httpx.Response(200, json=ok_response({"pong": True}))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.get("/v1/ping") == {"pong": True}

    assert route.called
    req = route.calls[0].request
    assert req.method == "GET"
    assert req.headers["Authorization"] == f"Bearer {API_KEY}"
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_sends_x_sdk_version_header():
    route = respx.get(f"{BASE_URL}/v1/version").mock(
        return_value=httpx.Response(200, json=ok_response({"ok": True}))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    await c.get("/v1/version")
    req = route.calls[0].request
    assert req.headers["X-SDK-Version"] == SDK_VERSION
    assert req.headers["X-Relaycast-Origin-Surface"] == "sdk"
    assert req.headers["X-Relaycast-Origin-Client"] == "@relaycast/python-sdk"
    assert req.headers["X-Relaycast-Origin-Version"] == SDK_VERSION
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_post_sends_post_with_json_body_and_content_type_header():
    route = respx.post(f"{BASE_URL}/v1/things").mock(
        return_value=httpx.Response(200, json=ok_response({"id": "t1"}))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.post("/v1/things", body={"name": "n"}) == {"id": "t1"}

    req = route.calls[0].request
    assert req.method == "POST"
    assert req.headers["Content-Type"] == "application/json"
    assert _req_json(req) == {"name": "n"}
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_patch_sends_patch():
    route = respx.patch(f"{BASE_URL}/v1/things/t1").mock(
        return_value=httpx.Response(200, json=ok_response({"updated": True}))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.patch("/v1/things/t1", body={"name": "n2"}) == {"updated": True}
    assert route.called
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_delete_sends_delete_and_returns_none():
    route = respx.delete(f"{BASE_URL}/v1/things/t1").mock(
        return_value=httpx.Response(200, json=ok_response(None))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.delete("/v1/things/t1") is None
    req = route.calls[0].request
    assert req.method == "DELETE"
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_successful_response_extracts_data_field():
    respx.get(f"{BASE_URL}/v1/data").mock(return_value=httpx.Response(200, json=ok_response({"a": 1})))
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.get("/v1/data") == {"a": 1}
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_error_response_raises_relay_error_with_code_message_status():
    respx.get(f"{BASE_URL}/v1/missing").mock(
        return_value=httpx.Response(404, json=error_response(code="not_found", message="Missing"))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    with pytest.raises(RelayError) as ei:
        await c.get("/v1/missing")
    err = ei.value
    assert err.code == "not_found"
    assert str(err) == "Missing"
    assert err.status == 404
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_invalid_response_missing_ok_field_raises_relay_error():
    respx.get(f"{BASE_URL}/v1/bad").mock(return_value=httpx.Response(200, json={"data": 123}))
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    with pytest.raises(RelayError) as ei:
        await c.get("/v1/bad")
    err = ei.value
    assert err.code == "invalid_response"
    assert str(err) == "Invalid API response"
    assert err.status == 200
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_query_params_are_encoded_in_url_and_none_values_are_filtered():
    respx.get(f"{BASE_URL}/v1/search?a=1&b=two").mock(
        return_value=httpx.Response(200, json=ok_response({"hits": []}))
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.get("/v1/search", query={"a": "1", "b": "two", "ignored": None}) == {"hits": []}
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_retries_5xx_up_to_3_times_then_succeeds(monkeypatch):
    from relay_sdk import client as client_module

    sleeps: list[float] = []

    async def _sleep(s: float):
        sleeps.append(s)

    monkeypatch.setattr(client_module.asyncio, "sleep", _sleep)

    route = respx.get(f"{BASE_URL}/v1/flaky").mock(
        side_effect=[
            httpx.Response(503, json=error_response(code="unavailable", message="nope")),
            httpx.Response(502, json=error_response(code="bad_gateway", message="nope")),
            httpx.Response(500, json=error_response(code="server_error", message="nope")),
            httpx.Response(200, json=ok_response({"ok": True})),
        ]
    )

    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    assert await c.get("/v1/flaky") == {"ok": True}
    assert route.call_count == 4
    assert sleeps == [0.2, 0.4, 0.8]
    await c.close()


@pytest.mark.asyncio
@respx.mock
async def test_async_http_client_5xx_that_never_recovers_raises_relay_error(monkeypatch):
    from relay_sdk import client as client_module

    sleeps: list[float] = []

    async def _sleep(s: float):
        sleeps.append(s)

    monkeypatch.setattr(client_module.asyncio, "sleep", _sleep)

    respx.get(f"{BASE_URL}/v1/down").mock(
        side_effect=[
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
            httpx.Response(503, json=error_response(code="unavailable", message="down")),
        ]
    )
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    with pytest.raises(RelayError) as ei:
        await c.get("/v1/down")
    err = ei.value
    assert err.code == "unavailable"
    assert str(err) == "down"
    assert err.status == 503
    assert sleeps == [0.2, 0.4, 0.8]
    await c.close()


@pytest.mark.asyncio
async def test_async_http_client_context_manager_calls_close(monkeypatch):
    c = AsyncHttpClient(api_key=API_KEY, base_url=BASE_URL)
    closed = {"called": 0}

    async def _aclose():
        closed["called"] += 1

    monkeypatch.setattr(c._client, "aclose", _aclose)

    async with c as client:
        assert client is c

    assert closed["called"] == 1
