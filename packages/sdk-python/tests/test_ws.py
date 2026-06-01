"""Tests for WsClient."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from relay_sdk.ws import WsClient


class TestWsClientInit:
    def test_default_base_url(self):
        ws = WsClient(token="at_xxx")
        assert ws._base_url == "wss://gateway.relaycast.dev"

    def test_custom_base_url_https(self):
        ws = WsClient(token="at_xxx", base_url="https://custom.example.com")
        assert ws._base_url == "wss://custom.example.com"

    def test_custom_base_url_http(self):
        ws = WsClient(token="at_xxx", base_url="http://localhost:3000")
        assert ws._base_url == "ws://localhost:3000"

    def test_strips_trailing_slash(self):
        ws = WsClient(token="at_xxx", base_url="https://example.com/")
        assert ws._base_url == "wss://example.com"

    def test_initial_state(self):
        ws = WsClient(token="at_xxx")
        assert ws._ws is None
        assert ws._handlers == {}
        assert ws._reconnect_attempt == 0
        assert ws._closed is False


class TestWsClientEvents:
    def test_on_registers_handler(self):
        ws = WsClient(token="at_xxx")
        handler = MagicMock()
        ws.on("message.created", handler)
        assert handler in ws._handlers["message.created"]

    def test_on_returns_unsubscribe(self):
        ws = WsClient(token="at_xxx")
        handler = MagicMock()
        unsub = ws.on("message.created", handler)
        assert handler in ws._handlers["message.created"]
        unsub()
        assert handler not in ws._handlers["message.created"]

    def test_off_removes_handler(self):
        ws = WsClient(token="at_xxx")
        handler = MagicMock()
        ws.on("test", handler)
        ws.off("test", handler)
        assert handler not in ws._handlers.get("test", set())

    def test_off_nonexistent_handler_no_error(self):
        ws = WsClient(token="at_xxx")
        handler = MagicMock()
        ws.off("test", handler)  # should not raise

    def test_emit_calls_handlers(self):
        ws = WsClient(token="at_xxx")
        handler = MagicMock()
        ws.on("test", handler)
        ws._emit("test", {"type": "test", "data": 42})
        handler.assert_called_once_with({"type": "test", "data": 42})

    def test_emit_calls_wildcard_handlers(self):
        ws = WsClient(token="at_xxx")
        handler = MagicMock()
        ws.on("*", handler)
        ws._emit("message.created", {"type": "message.created"})
        handler.assert_called_once_with({"type": "message.created"})

    def test_emit_both_specific_and_wildcard(self):
        ws = WsClient(token="at_xxx")
        specific = MagicMock()
        wildcard = MagicMock()
        ws.on("test", specific)
        ws.on("*", wildcard)
        ws._emit("test", {"type": "test"})
        specific.assert_called_once()
        wildcard.assert_called_once()

    def test_emit_handler_exception_does_not_stop_others(self):
        ws = WsClient(token="at_xxx")
        bad = MagicMock(side_effect=ValueError("boom"))
        good = MagicMock()
        ws.on("test", bad)
        ws.on("test", good)
        ws._emit("test", {"type": "test"})
        bad.assert_called_once()
        good.assert_called_once()

    def test_multiple_handlers_same_event(self):
        ws = WsClient(token="at_xxx")
        h1 = MagicMock()
        h2 = MagicMock()
        ws.on("test", h1)
        ws.on("test", h2)
        ws._emit("test", {"type": "test"})
        h1.assert_called_once()
        h2.assert_called_once()


class TestWsClientSubscriptions:
    def test_subscribe_stores_channels(self):
        ws = WsClient(token="at_xxx")
        ws.subscribe(["general", "code-review"])
        assert "general" in ws._pending_subscriptions
        assert "code-review" in ws._pending_subscriptions

    def test_subscribe_deduplicates(self):
        ws = WsClient(token="at_xxx")
        ws.subscribe(["general"])
        ws.subscribe(["general", "test"])
        assert ws._pending_subscriptions.count("general") == 1

    def test_unsubscribe_removes_channels(self):
        ws = WsClient(token="at_xxx")
        ws.subscribe(["general", "code-review"])
        ws.unsubscribe(["general"])
        assert "general" not in ws._pending_subscriptions
        assert "code-review" in ws._pending_subscriptions


class TestWsClientDisconnect:
    def test_disconnect_sets_closed(self):
        ws = WsClient(token="at_xxx")
        ws.disconnect()
        assert ws._closed is True

    def test_disconnect_cancels_ping_task(self):
        ws = WsClient(token="at_xxx")
        mock_task = MagicMock()
        ws._ping_task = mock_task
        ws.disconnect()
        mock_task.cancel.assert_called_once()
        assert ws._ping_task is None


class TestWsClientOriginParams:
    @pytest.mark.asyncio
    async def test_connect_url_includes_origin_query_params(self):
        ws = WsClient(token="at_xxx")
        with patch("relay_sdk.ws.websockets.connect", side_effect=RuntimeError("stop")) as connect_mock:
            with pytest.raises(RuntimeError):
                await ws._connect_once()

        url = connect_mock.call_args.args[0]
        assert "/v1/ws?" in url
        assert "token=at_xxx" in url
        assert "origin_surface=sdk" in url
        assert "origin_client=%40relaycast%2Fpython-sdk" in url
        assert "origin_version=0.1.0" in url
