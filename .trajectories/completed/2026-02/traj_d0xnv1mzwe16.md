# Trajectory: Host observer dashboard on observer.relaycast.dev and prNN-observer.relaycast.dev with env-aware API routing

> **Status:** ✅ Completed
> **Confidence:** 87%
> **Started:** February 18, 2026 at 09:05 PM
> **Completed:** February 18, 2026 at 09:15 PM

---

## Summary

Added observer hostname router worker deployment and docs so observer.relaycast.dev, staging-observer.relaycast.dev, and prNN-observer.relaycast.dev map to the correct API environment via host-aware dashboard routing.

**Approach:** Standard approach

---

## Key Decisions

### Use observer hostname router worker in front of Pages
- **Chose:** Use observer hostname router worker in front of Pages
- **Reasoning:** Cloudflare Pages does not support wildcard custom domains for prNN-observer hosts, so a Worker route layer is needed for observer/review subdomains while keeping dashboard app on Pages.

---

## Chapters

### 1. Work
*Agent: default*

- Use observer hostname router worker in front of Pages: Use observer hostname router worker in front of Pages
