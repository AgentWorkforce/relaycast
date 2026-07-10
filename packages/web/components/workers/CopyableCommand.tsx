"use client";

import { useCallback, useState } from "react";
import { Button } from "@/app/components/ui/button";

type CopyableCommandProps = {
  command: string;
  label?: string;
};

export function CopyableCommand({ command, label = "Command" }: CopyableCommandProps) {
  const [copied, setCopied] = useState(false);
  const renderCodeText = useCallback(
    (node: HTMLElement | null) => {
      if (node && node.textContent !== command) {
        node.textContent = command;
      }
    },
    [command],
  );

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--code-border)] bg-[var(--code-bg)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--code-border)] bg-[var(--code-topbar)] px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--code-muted)]">
          {label}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 border-[var(--code-border)] bg-transparent text-[var(--code-fg)] hover:bg-white/10"
          onClick={copyCommand}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-6 text-[var(--code-fg)]">
        <code ref={renderCodeText}>{command}</code>
      </pre>
    </div>
  );
}
