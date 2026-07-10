import { describe, expect, it } from "vitest";

import {
  extractLinearExternalId,
  extractLinearMutationOutcome,
  extractLinearRequestExternalId,
  linearMutationKey,
} from "./linear-writeback-response";

describe("linear writeback response parsing", () => {
  it("extracts normalized project action output from Nango actions", () => {
    const payload = { id: "project-1", success: true };

    expect(extractLinearExternalId(payload, "archive-project")).toBe("project-1");
    expect(extractLinearMutationOutcome(payload, "archive-project")).toEqual({
      success: true,
      message: undefined,
    });
  });

  it("reads GraphQL project mutation success and external ids", () => {
    const payload = {
      data: {
        projectCreate: {
          success: true,
          project: { id: "project-2" },
        },
      },
    };

    expect(linearMutationKey("create-project")).toBe("projectCreate");
    expect(extractLinearExternalId(payload, "create-project")).toBe("project-2");
    expect(extractLinearMutationOutcome(payload, "create-project")).toEqual({
      success: true,
      message: undefined,
    });
  });

  it("reports GraphQL project mutation success false as a failure", () => {
    const payload = {
      data: {
        projectUpdate: {
          success: false,
          project: null,
        },
      },
    };

    expect(extractLinearMutationOutcome(payload, "update-project")).toEqual({
      success: false,
      message: "Linear projectUpdate returned success: false",
    });
  });

  it("reports partial add-issues-to-project failures", () => {
    const payload = {
      results: [
        { issueId: "issue-1", success: true },
        { issueId: "issue-2", success: false, error: "team mismatch" },
      ],
    };

    expect(extractLinearMutationOutcome(payload, "add-issues-to-project")).toEqual({
      success: false,
      message: "team mismatch",
    });
  });

  it("reads GraphQL label mutation success and external ids", () => {
    const payload = {
      data: {
        issueLabelCreate: {
          success: true,
          issueLabel: { id: "label-1", name: "Escalation" },
        },
      },
    };

    expect(linearMutationKey("create_label")).toBe("issueLabelCreate");
    expect(extractLinearExternalId(payload, "create_label")).toBe("label-1");
    expect(extractLinearMutationOutcome(payload, "create_label")).toEqual({
      success: true,
      message: undefined,
    });
  });

  it("falls back to request variables for delete label external ids", () => {
    expect(
      extractLinearRequestExternalId({
        action: "delete_label",
        method: "POST",
        endpoint: "/graphql",
        body: {
          query: "mutation RelayfileIssueLabelDelete { issueLabelDelete { success } }",
          variables: { id: "label-1" },
        },
      }),
    ).toBe("label-1");
  });
});
