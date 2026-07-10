export type WriteAdmissionPurposeBody = {
  purpose?: string;
  reason?: string;
};

export type WriteAdmissionClass =
  | "foreground_control"
  | "foreground_content"
  | "background_integration"
  | "maintenance";

export type WriteAdmissionDecisionInput = {
  writeClass: WriteAdmissionClass;
  inflight: number;
  foregroundInflight: number;
  maxInflight: number;
  foregroundReserved: number;
  backgroundMax: number;
};

export type WriteAdmissionDecision = {
  admit: boolean;
  backgroundInflight: number;
  reason?: "write_admission_limit";
};

const WRITE_ADMISSION_CLASSES = new Set<WriteAdmissionClass>([
  "foreground_control",
  "foreground_content",
  "background_integration",
  "maintenance",
]);

export function resolveWriteAdmissionLeaseReason(
  body: WriteAdmissionPurposeBody,
): string {
  return body.purpose?.trim() || body.reason?.trim() || "";
}

export function resolveWriteAdmissionClass(
  value: unknown,
): WriteAdmissionClass {
  return typeof value === "string" &&
    WRITE_ADMISSION_CLASSES.has(value as WriteAdmissionClass)
    ? (value as WriteAdmissionClass)
    : "background_integration";
}

export function isForegroundWriteAdmissionClass(
  writeClass: WriteAdmissionClass,
): boolean {
  return (
    writeClass === "foreground_control" || writeClass === "foreground_content"
  );
}

export function decideWriteAdmission(
  input: WriteAdmissionDecisionInput,
): WriteAdmissionDecision {
  const backgroundInflight = Math.max(
    0,
    input.inflight - input.foregroundInflight,
  );
  const isForeground = isForegroundWriteAdmissionClass(input.writeClass);
  const saturated =
    input.inflight >= input.maxInflight ||
    (!isForeground && backgroundInflight >= input.backgroundMax);

  return {
    admit: !saturated,
    backgroundInflight,
    reason: saturated ? "write_admission_limit" : undefined,
  };
}
