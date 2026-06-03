# Trajectory: Fix stale dashboard observer token handling and duplicate session fetch race

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 18, 2026 at 05:41 PM
> **Completed:** February 18, 2026 at 05:41 PM

---

## Summary

Dashboard session route now self-heals invalid observer tokens reliably and provider ignores stale duplicate responses

**Approach:** Standard approach

---

## Key Decisions

### Validate observer token using agent-auth endpoint in /api/auth/session
- **Chose:** Validate observer token using agent-auth endpoint in /api/auth/session
- **Reasoning:** Previous logic swallowed join failures and could return authenticated=true with invalid at_live token, breaking websocket auth

### Guard RelaySessionProvider against stale concurrent session responses
- **Chose:** Guard RelaySessionProvider against stale concurrent session responses
- **Reasoning:** Dev double-invocation can issue multiple /api/auth/session requests; only latest response should set session token

---

## Chapters

### 1. Work
*Agent: default*

- Validate observer token using agent-auth endpoint in /api/auth/session: Validate observer token using agent-auth endpoint in /api/auth/session
- Guard RelaySessionProvider against stale concurrent session responses: Guard RelaySessionProvider against stale concurrent session responses
