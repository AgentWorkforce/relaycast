import { describe, expect, it } from "vitest";
import {
  computePath,
  normalizeWebhook,
  type GitHubNormalizedWebhook,
} from "@/lib/integrations/github-relayfile";
import { GithubFanout } from "./github";

const repository = {
  name: "cloud",
  full_name: "AgentWorkforce/cloud",
  owner: { login: "AgentWorkforce" },
};

function normalized(
  event: string,
  payload: Record<string, unknown>,
): GitHubNormalizedWebhook {
  return normalizeWebhook({
    headers: { "x-github-event": event },
    connectionId: "conn-github-1",
    payload: {
      repository,
      ...payload,
    },
  });
}

describe("GithubFanout", () => {
  it("normalizes webhooks and preserves the existing path mapper outputs", () => {
    const records = [
      normalized("pull_request", {
        action: "opened",
        pull_request: { number: 1803, title: "Trigger review" },
      }),
      normalized("issues", {
        action: "opened",
        issue: {
          number: 2174,
          title:
            "factory decouple relayfile per-path deny enforcement from token-carried workspace scopes",
        },
      }),
      normalized("issue_comment", {
        action: "created",
        issue: { number: 2174, title: "Factory scope enforcement" },
        comment: { id: 9901 },
      }),
      normalized("pull_request_review", {
        action: "submitted",
        pull_request: { number: 1803, title: "Trigger review" },
        review: { id: 7701 },
      }),
      normalized("pull_request_review_comment", {
        action: "created",
        pull_request: { number: 1803, title: "Trigger review" },
        comment: { id: 8801 },
      }),
      normalized("check_run", {
        action: "completed",
        check_run: { id: 555 },
      }),
      normalized("deployment_status", {
        action: "created",
        deployment: { id: 42 },
        deployment_status: { id: 555 },
      }),
      normalized("push", {
        after: "deadbeef",
        head_commit: { id: "deadbeef" },
      }),
    ];

    expect(records.map((record) => GithubFanout.pathFor(record))).toEqual(
      records.map((record) => computePath(record)),
    );
    expect(records.map((record) => GithubFanout.shouldWrite(record))).toEqual(
      records.map(() => true),
    );
  });
});
