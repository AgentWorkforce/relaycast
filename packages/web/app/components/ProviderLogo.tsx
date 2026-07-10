"use client";

import { useEffect, useState } from "react";
import { Blocks } from "lucide-react";
import { cn } from "@/lib/utils";

type ProviderLogoProps = {
  provider: string;
  label?: string;
  size?: number;
  className?: string;
};

// Slugs whose Nango template-logo lives under a different name. Note the
// CDN serves a soft-404 (HTTP 200 with a text/html SPA shell) for unknown
// slugs, so a missing logo only surfaces as an <img> decode error at
// runtime — verify candidates with `curl -w "%{content_type}"`, not the
// status code.
const LOGO_SLUG_ALIASES: Record<string, string> = {
  // X rebranded; Nango still publishes the logo under its twitter slug.
  x: "twitter",
  // Composio-backed config keys use an underscored slug.
  docker_hub: "docker-hub",
};

export function normalizeProviderLogoSlug(provider: string): string {
  const trimmed = provider.trim().toLowerCase();
  // Call sites sometimes hold a connection config key rather than the
  // catalog id; strip the relayfile convention suffixes
  // (`<integration>-relay`, `<integration>-composio-relay`) first.
  const base = trimmed.replace(/-(?:composio-)?relay$/, "");
  return LOGO_SLUG_ALIASES[base] ?? base;
}

export function ProviderLogo({
  provider,
  label,
  size = 20,
  className,
}: ProviderLogoProps) {
  const slug = normalizeProviderLogoSlug(provider);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [slug]);

  if (!slug || failed) {
    // Generic neutral glyph for providers without a published template
    // logo (e.g. docker-hub, daytona). Intentional-looking, unlike the
    // text-initials badge this replaces.
    return (
      <span
        role="img"
        aria-label={`${label ?? provider} provider`}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <Blocks
          aria-hidden
          style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }}
        />
      </span>
    );
  }

  return (
    <img
      src={`https://app.nango.dev/images/template-logos/${slug}.svg`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={cn("shrink-0 object-contain", className)}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}
