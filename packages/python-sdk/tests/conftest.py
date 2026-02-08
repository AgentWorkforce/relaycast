"""Shared test fixtures."""

import pytest


BASE_URL = "https://test.agentrelay.dev"
API_KEY = "rk_test_abc123"
AGENT_TOKEN = "at_test_xyz789"


def ok_response(data):
    """Wrap data in API success envelope."""
    return {"ok": True, "data": data}


def error_response(code="not_found", message="Not found", status=404):
    """Wrap data in API error envelope."""
    return {"ok": False, "error": {"code": code, "message": message}}
