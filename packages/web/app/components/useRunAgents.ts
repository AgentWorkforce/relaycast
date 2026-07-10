"use client";

import { useEffect, useState } from "react";
import { toAppPath } from "@/lib/app-path";

export type RunAgent = {
  name: string;
  hasLogs: boolean;
};

type RunAgentsResponse = {
  agents?: RunAgent[];
};

export function useRunAgents(runId: string | null | undefined) {
  const [agents, setAgents] = useState<RunAgent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!runId) {
      setAgents([]);
      setIsLoading(false);
      return;
    }

    let active = true;
    const controller = new AbortController();

    const loadAgents = async () => {
      setIsLoading(true);

      try {
        const response = await fetch(toAppPath(`/api/v1/workflows/runs/${runId}/agents`), {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Failed to load agents: ${response.status}`);
        }

        const payload = (await response.json().catch(() => null)) as RunAgentsResponse | null;
        if (!active) {
          return;
        }

        setAgents(Array.isArray(payload?.agents) ? payload.agents : []);
      } catch {
        if (!active || controller.signal.aborted) {
          return;
        }

        setAgents([]);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    };

    loadAgents().catch(() => {});

    return () => {
      active = false;
      controller.abort();
    };
  }, [runId]);

  return { agents, isLoading };
}
