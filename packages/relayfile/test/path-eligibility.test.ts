import { describe, expect, it } from "vitest";

import { getUnsupportedWritebackReason } from "../src/writeback/path-eligibility.js";

describe("writeback path eligibility", () => {
  it("allows Linear label create, update, and delete paths", () => {
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/labels/new-label.json",
        "file_upsert",
      ),
    ).toBeNull();
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/labels/escalation__11111111-1111-4111-8111-111111111111.json",
        "file_upsert",
      ),
    ).toBeNull();
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/labels/escalation__11111111-1111-4111-8111-111111111111.json",
        "file_delete",
      ),
    ).toBeNull();
  });

  it("allows Linear project create, update, assignment, and delete paths", () => {
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/projects/create-roadmap.json",
        "file_upsert",
      ),
    ).toBeNull();
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/projects/roadmap__11111111-1111-4111-8111-111111111111.json",
        "file_upsert",
      ),
    ).toBeNull();
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/projects/11111111-1111-4111-8111-111111111111/meta.json",
        "file_upsert",
      ),
    ).toBeNull();
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/projects/11111111-1111-4111-8111-111111111111/add-issues.json",
        "file_upsert",
      ),
    ).toBeNull();
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/projects/roadmap__11111111-1111-4111-8111-111111111111.json",
        "file_delete",
      ),
    ).toBeNull();
  });

  it("rejects unsupported Linear resource paths", () => {
    expect(
      getUnsupportedWritebackReason(
        "linear",
        "/linear/users/11111111-1111-4111-8111-111111111111.json",
        "file_upsert",
      ),
    ).toBe(
      "unsupported Linear writeback path: /linear/users/11111111-1111-4111-8111-111111111111.json",
    );
  });
});
