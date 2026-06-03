"""Relay SDK — Python client for Relay Transport."""

from .agent import AgentClient, AsyncAgentClient
from .client import (
    AGENT_RELAY_ANONYMOUS_ID_HEADER,
    AGENT_RELAY_ANONYMOUS_ID_QUERY,
    AsyncHttpClient,
    HttpClient,
    SDK_VERSION,
    sanitize_agent_relay_anonymous_id,
)
from .errors import RelayError
from .relay import AsyncRelay, Relay
from .ws import WsClient

__version__ = SDK_VERSION

__all__ = [
    "AgentClient",
    "AGENT_RELAY_ANONYMOUS_ID_HEADER",
    "AGENT_RELAY_ANONYMOUS_ID_QUERY",
    "AsyncAgentClient",
    "AsyncHttpClient",
    "AsyncRelay",
    "HttpClient",
    "Relay",
    "RelayError",
    "SDK_VERSION",
    "WsClient",
    "sanitize_agent_relay_anonymous_id",
]
