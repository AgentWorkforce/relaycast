import { describe, expect, it } from "vitest";
import { formatRickyRunEventSse } from "../../../../app/api/v1/ricky/runs/[rickyRunId]/events/route";

describe("Ricky run events SSE formatting", () => {
  it("emits event snapshots as data lines", () => {
    const output = formatRickyRunEventSse({
      id: "evt_1",
      rickyRunId: "run_1",
      sequence: 1,
      eventType: "linear.run.started",
      payload: { sessionId: "as_1" },
      createdAt: "2026-05-07T12:00:00.000Z",
    });

    expect(output.endsWith("\n\n")).toBe(true);
    expect(output.startsWith("data: ")).toBe(true);
    expect(output).toMatch(/"eventType":"linear\.run\.started"/);
  });
});
