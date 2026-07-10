"use client";

import posthog from "posthog-js";

let initialized = false;

export function getBrowserPostHog() {
  if (typeof window === "undefined") {
    return null;
  }

  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) {
    return null;
  }

  if (!initialized) {
    posthog.init(apiKey, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      capture_pageview: false,
      capture_pageleave: true,
      capture_exceptions: true,
    });
    initialized = true;
  }

  return posthog;
}
