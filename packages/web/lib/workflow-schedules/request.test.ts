import { describe, expect, it } from "vitest";
import {
  generateScheduleWebhookSecret,
  hashScheduleWebhookSecret,
  parseCreateWorkflowScheduleRequest,
  verifyScheduleWebhookSecret,
} from "./request";

describe("workflow schedule request helpers", () => {
  it("accepts nested workflow run payloads and normalizes one-time dates", () => {
    const parsed = parseCreateWorkflowScheduleRequest({
      name: "Nightly eval",
      schedule_type: "once",
      scheduled_at: "2026-05-09T12:00:00.000Z",
      run: {
        workflow: "name: eval",
        fileType: "yaml",
        metadata: { EVAL_NAME: "nightly" },
      },
    });

    expect(parsed.scheduleType).toBe("once");
    expect(parsed.scheduledAt).toBe("2026-05-09T12:00:00.000Z");
    expect(parsed.workflowRequest).toEqual({
      workflow: "name: eval",
      fileType: "yaml",
      metadata: { EVAL_NAME: "nightly" },
    });
  });

  it("rejects fixed run IDs so recurring schedules get unique runs", () => {
    expect(() =>
      parseCreateWorkflowScheduleRequest({
        name: "Bad schedule",
        schedule_type: "cron",
        cron_expression: "0 * * * *",
        workflowRequest: {
          workflow: "name: eval",
          fileType: "yaml",
          runId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).toThrow("scheduled workflows cannot provide runId");
  });

  it("rejects one-time code sync fields that would not repeat", () => {
    expect(() =>
      parseCreateWorkflowScheduleRequest({
        name: "Bad code sync schedule",
        schedule_type: "cron",
        cron_expression: "0 * * * *",
        workflowRequest: {
          workflow: "name: eval",
          fileType: "yaml",
          s3CodeKey: "code.tar.gz",
        },
      }),
    ).toThrow("scheduled workflows cannot provide s3CodeKey");
  });

  it("verifies webhook secrets with a hash-only stored value", () => {
    const secret = generateScheduleWebhookSecret();
    const hash = hashScheduleWebhookSecret(secret);

    expect(verifyScheduleWebhookSecret(secret, hash)).toBe(true);
    expect(verifyScheduleWebhookSecret(`${secret}-wrong`, hash)).toBe(false);
  });
});
