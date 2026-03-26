# Trajectory: Move @relaycast/brand package to ../relay and remove relaycast publish references

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** March 26, 2026 at 11:17 AM
> **Completed:** March 26, 2026 at 11:18 AM

---

## Summary

Added a Relay-style dark/light mode toggle to the static Relaycast site with persisted theme selection and brand-aligned light/dark tokens.

**Approach:** Standard approach

---

## Key Decisions

### Used a standalone vanilla JS theme toggle that mirrors Relay’s dataset/color-scheme/localStorage behavior
- **Chose:** Used a standalone vanilla JS theme toggle that mirrors Relay’s dataset/color-scheme/localStorage behavior
- **Reasoning:** The site is static HTML/CSS/JS, so matching the React component behavior directly in DOM code avoids framework coupling while preserving the same UX contract.

---

## Chapters

### 1. Work
*Agent: default*

- Used a standalone vanilla JS theme toggle that mirrors Relay’s dataset/color-scheme/localStorage behavior: Used a standalone vanilla JS theme toggle that mirrors Relay’s dataset/color-scheme/localStorage behavior
