"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WizardStepMeta } from "../_lib/types";

type WizardStepperProps = {
  steps: WizardStepMeta[];
  currentIndex: number;
};

export function WizardStepper({ steps, currentIndex }: WizardStepperProps) {
  return (
    <nav aria-label="Deploy steps" className="flex flex-col gap-3">
      {steps.map((step, index) => {
        const completed = index < currentIndex;
        const active = index === currentIndex;

        return (
          <div key={step.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex size-9 items-center justify-center rounded-full border text-sm font-semibold transition-colors",
                  completed
                    ? "border-primary bg-primary text-primary-foreground"
                    : active
                      ? "border-primary bg-[var(--surface-soft)] text-primary shadow-[0_0_0_4px_rgba(125,145,255,0.16)]"
                      : "border-[var(--border-default)] bg-[var(--dashboard-panel)] text-muted-foreground",
                )}
              >
                {completed ? <Check aria-hidden="true" /> : index + 1}
              </div>
              {index < steps.length - 1 ? (
                <div
                  className={cn(
                    "mt-2 h-8 w-px rounded-full",
                    completed ? "bg-primary" : "bg-[var(--border-default)]",
                  )}
                />
              ) : null}
            </div>
            <div className="min-w-0 pb-2 pt-1">
              <p
                className={cn(
                  "truncate text-sm font-medium",
                  active || completed ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {step.shortTitle}
              </p>
              <p className="mt-1 hidden text-xs leading-5 text-muted-foreground sm:block">
                {step.title}
              </p>
            </div>
          </div>
        );
      })}
    </nav>
  );
}
