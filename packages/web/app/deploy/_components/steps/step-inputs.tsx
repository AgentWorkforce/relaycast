"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/app/components/ui/badge";
import { Input } from "@/app/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";
import { fetchLivePickerOptions, type LivePickerOption } from "../../_lib/picker-options-client";
import type { DeployMode, PersonaInputSummary } from "../../_lib/types";

type StepInputsProps = {
  inputs: PersonaInputSummary[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  mode: DeployMode;
  workspaceId: string | null;
};

type LivePickerState =
  | { status: "loading"; options: LivePickerOption[] }
  | { status: "ready"; options: LivePickerOption[] }
  | { status: "fallback"; options: LivePickerOption[]; message: string };

function demoPickerOptions(input: PersonaInputSummary): LivePickerOption[] {
  const provider = input.picker?.provider;
  const resource = input.picker?.resource;

  if (provider === "slack" && resource === "channels") {
    return ["#general", "#eng", "#alerts", "#launches"].map((option) => ({ value: option, label: option }));
  }
  if (provider === "github" && resource === "users") {
    return ["requester-login", "review-lead", "platform-team", "any-approver"].map((option) => ({ value: option, label: option }));
  }
  if (provider === "linear" && resource === "teams") {
    return ["Platform", "Product", "Growth", "Infrastructure"].map((option) => ({ value: option, label: option }));
  }
  if (provider === "notion" && resource === "databases") {
    return ["Engineering Journal", "Release Notes", "Research Log", "Ops Tracker"].map((option) => ({ value: option, label: option }));
  }
  return ["Primary", "Team default", "Alerts", "Archive"].map((option) => ({ value: option, label: option }));
}

function fallbackMessage(provider: string, resource: string) {
  return `Could not load ${provider} ${resource}. Enter a value manually.`;
}

export function StepInputs({ inputs, values, onChange, mode, workspaceId }: StepInputsProps) {
  const [livePickerStates, setLivePickerStates] = useState<Record<string, LivePickerState>>({});
  const livePickerInputs = useMemo(
    () => inputs.filter((input) => input.picker),
    [inputs],
  );

  useEffect(() => {
    if (mode !== "live" || !workspaceId || livePickerInputs.length === 0) {
      setLivePickerStates({});
      return;
    }

    let active = true;
    setLivePickerStates(() =>
      Object.fromEntries(livePickerInputs.map((input) => [input.key, { status: "loading", options: [] }])),
    );

    for (const input of livePickerInputs) {
      const picker = input.picker;
      if (!picker) continue;
      fetchLivePickerOptions({
        workspaceId,
        provider: picker.provider,
        resource: picker.resource,
      })
        .then((options) => {
          if (!active) return;
          setLivePickerStates((current) => ({
            ...current,
            [input.key]: options.length > 0
              ? { status: "ready", options }
              : {
                  status: "fallback",
                  options: [],
                  message: fallbackMessage(picker.provider, picker.resource),
                },
          }));
        })
        .catch(() => {
          if (!active) return;
          setLivePickerStates((current) => ({
            ...current,
            [input.key]: {
              status: "fallback",
              options: [],
              message: fallbackMessage(picker.provider, picker.resource),
            },
          }));
        });
    }

    return () => {
      active = false;
    };
  }, [livePickerInputs, mode, workspaceId]);

  return (
    <div className="flex flex-col gap-4">
      {inputs.map((input) => {
        const value = values[input.key] ?? "";
        const missingRequired = !input.optional && value.trim().length === 0;
        const pickerState = input.picker ? livePickerStates[input.key] : undefined;
        const useLivePicker = mode === "live" && Boolean(workspaceId);
        const options = useLivePicker ? pickerState?.options ?? [] : demoPickerOptions(input);
        const pickerIsLoading = useLivePicker && input.picker && (!pickerState || pickerState.status === "loading");
        const pickerFallsBack = useLivePicker && input.picker && pickerState?.status === "fallback";

        return (
          <div key={input.key} className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-soft)] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="font-medium text-foreground" htmlFor={input.key}>
                {input.key}
              </label>
              {input.optional ? <Badge>Optional</Badge> : null}
              {missingRequired ? (
                <span className="text-xs font-medium text-[var(--status-danger)]">Required</span>
              ) : null}
            </div>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">{input.description}</p>
            {input.picker && !pickerFallsBack ? (
              <Select
                value={value}
                onValueChange={(nextValue) => onChange(input.key, nextValue)}
                disabled={Boolean(pickerIsLoading)}
              >
                <SelectTrigger id={input.key} className="mt-4 w-full" aria-invalid={missingRequired}>
                  <SelectValue placeholder={pickerIsLoading ? "Loading options..." : "Select a value"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {options.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{option.label}</span>
                          {option.hint ? <span className="truncate text-xs text-muted-foreground">{option.hint}</span> : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : (
              <>
                {pickerFallsBack ? (
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">{pickerState.message}</p>
                ) : null}
                <Input
                  id={input.key}
                  className="mt-4"
                  value={value}
                  placeholder={input.default ?? input.key}
                  aria-invalid={missingRequired}
                  onChange={(event) => onChange(input.key, event.target.value)}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
