"""Local relaycast runtime helpers used by SDK local mode."""

from __future__ import annotations

import os
import stat
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx

DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:7528"


def ensure_local_runtime(
    *,
    api_key: str | None,
    base_url: str | None,
) -> tuple[str, str]:
    """Ensure local daemon is available and return resolved (api_key, base_url)."""
    resolved_base_url = (base_url or os.environ.get("RELAYCAST_LOCAL_BASE_URL") or DEFAULT_LOCAL_BASE_URL).rstrip("/")
    parsed = urlparse(resolved_base_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 7528

    resolved_api_key = (api_key or "").strip()
    if not resolved_api_key:
        raise RuntimeError("Relay api_key is required")

    if not is_healthy(resolved_base_url):
        binary = resolve_local_binary()
        subprocess.Popen(  # noqa: S603
            [str(binary), "--host", host, "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        if not wait_for_health(resolved_base_url, attempts=40, sleep_secs=0.1):
            raise RuntimeError(
                f"Failed to start local relaycast daemon at {resolved_base_url}. "
                "Set RELAYCAST_LOCAL_BIN to an existing local binary."
            )

    return resolved_api_key, resolved_base_url


def resolve_local_binary() -> Path:
    env_binary = os.environ.get("RELAYCAST_LOCAL_BIN", "").strip()
    if env_binary:
        binary = Path(env_binary).expanduser().resolve()
        if not binary.exists():
            raise RuntimeError(f"RELAYCAST local binary not found: {binary}")
        return binary

    asset = binary_asset_name()

    package_bin = Path(__file__).resolve().parent / "bin" / asset
    if package_bin.exists():
        ensure_executable(package_bin)
        return package_bin

    raise RuntimeError(
        f"Bundled local binary not found for {asset}. "
        "Set RELAYCAST_LOCAL_BIN to an existing local binary."
    )


def binary_asset_name() -> str:
    platform = os.sys.platform
    machine = os.uname().machine if hasattr(os, "uname") else ""
    machine = machine.lower()

    if platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "local-darwin-arm64"
    if platform == "darwin" and machine in {"x86_64", "amd64"}:
        return "local-darwin-x64"
    if platform.startswith("linux") and machine in {"x86_64", "amd64"}:
        return "local-linux-x64"
    if platform in {"win32", "cygwin"} and os.environ.get("PROCESSOR_ARCHITECTURE", "").lower() in {"amd64", "x86_64"}:
        return "local-windows-x64.exe"

    raise RuntimeError(f"Unsupported platform for local relaycast runtime: {platform}/{machine}")

def ensure_executable(path: Path) -> None:
    if os.sys.platform in {"win32", "cygwin"}:
        return
    current = path.stat().st_mode
    path.chmod(current | stat.S_IXUSR)


def is_healthy(base_url: str) -> bool:
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/health", timeout=0.6)
        return response.status_code == 200
    except Exception:  # noqa: BLE001
        return False


def wait_for_health(base_url: str, *, attempts: int, sleep_secs: float) -> bool:
    for _ in range(attempts):
        if is_healthy(base_url):
            return True
        time.sleep(sleep_secs)
    return False
