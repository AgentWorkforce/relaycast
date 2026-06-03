# Trajectory: Host observer dashboard and map observer hostnames to matching API env

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** February 18, 2026 at 08:49 PM
> **Completed:** February 18, 2026 at 09:03 PM

---

## Summary

Added host-based observer->API routing in dashboard API handlers and wired CI to deploy observer dashboard to Cloudflare Pages plus preview PR links to prNN-observer domains.

**Approach:** Standard approach

---

## Key Decisions

### Resolve observer API target from request host
- **Chose:** Resolve observer API target from request host
- **Reasoning:** Allows a single observer deployment to auto-connect to production or PR API environments based on observer hostname

### Deploy observer dashboard with Cloudflare next-on-pages in CI
- **Chose:** Deploy observer dashboard with Cloudflare next-on-pages in CI
- **Reasoning:** Keeps existing Next.js API route behavior while publishing observer.relaycast.dev from the same repo and workflows

---

## Chapters

### 1. Work
*Agent: default*

- Resolve observer API target from request host: Resolve observer API target from request host
- Deploy observer dashboard with Cloudflare next-on-pages in CI: Deploy observer dashboard with Cloudflare next-on-pages in CI
