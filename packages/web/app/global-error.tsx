"use client";

import { useEffect } from "react";
import { getBrowserPostHog } from "@/lib/posthog-client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const posthog = getBrowserPostHog();
    if (!posthog) return;

    posthog.capture("next_global_error", {
      message: error.message,
      stack: error.stack,
      digest: error.digest,
    });
  }, [error]);

  return (
    <html>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
        <h2>Something went wrong.</h2>
        <p>We logged the error and will investigate.</p>
        <button onClick={() => reset()} style={{ marginTop: 12 }}>
          Try again
        </button>
      </body>
    </html>
  );
}
