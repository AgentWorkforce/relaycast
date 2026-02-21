"""Smoke tests for package imports."""

import relay_sdk


def test_version():
    assert relay_sdk.__version__ == "0.1.0"
    assert relay_sdk.SDK_VERSION == "0.1.0"


def test_exports():
    assert hasattr(relay_sdk, "Relay")
    assert hasattr(relay_sdk, "AsyncRelay")
    assert hasattr(relay_sdk, "AgentClient")
    assert hasattr(relay_sdk, "AsyncAgentClient")
    assert hasattr(relay_sdk, "HttpClient")
    assert hasattr(relay_sdk, "AsyncHttpClient")
    assert hasattr(relay_sdk, "WsClient")
    assert hasattr(relay_sdk, "RelayError")
