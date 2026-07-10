"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

const AGENT_CARD_DIRECTORY_ALIASES: Record<string, string> = {
  "granola-prospect": "granola",
  "linear-chat-lead": "linear",
  "pr-reviewer": "review",
};

function cardImageUrl(deployedName: string | null | undefined) {
  const slug = deployedName?.trim();
  if (!slug) return null;
  const directory = AGENT_CARD_DIRECTORY_ALIASES[slug] ?? slug;
  return `https://raw.githubusercontent.com/AgentWorkforce/agents/main/${encodeURIComponent(directory)}/card-sm.png`;
}

export function AgentCardThumbnail({
  deployedName,
  imageUrl,
  className,
}: {
  deployedName: string | null | undefined;
  imageUrl?: string | null | undefined;
  className?: string;
}) {
  const url = imageUrl?.trim() || cardImageUrl(deployedName);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (!url || failed) {
    return (
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--surface-soft)] text-primary",
          className,
        )}
      >
        <Bot aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={cn("size-10 shrink-0 rounded-2xl object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}
