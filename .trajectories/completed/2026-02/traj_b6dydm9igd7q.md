# Trajectory: Debug observer websocket stream status 404 on production

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 19, 2026 at 01:36 AM
> **Completed:** February 19, 2026 at 01:37 AM

---

## Summary

Diagnosed observer websocket/stream 404s as missing production Cloudflare route binding; updated deploy workflow to pass route api.relaycast.dev/* to deploy-worker

**Approach:** Standard approach

---

## Key Decisions

### Bind production API route during deploy
- **Chose:** Bind production API route during deploy
- **Reasoning:** api.relaycast.dev was still served by Fly (404 for /v1/ws and /v1/workspace/stream); production deploy lacked route input unlike staging

---

## Chapters

### 1. Work
*Agent: default*

- Bind production API route during deploy: Bind production API route during deploy
