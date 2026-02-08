"""Relay SDK error types."""


class RelayError(Exception):
    """Error returned by the Relay API."""

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status

    def __repr__(self) -> str:
        return f"RelayError(code={self.code!r}, message={self.args[0]!r}, status={self.status})"
