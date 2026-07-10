import { describe, expect, it } from "vitest";
import {
  deploymentRunErrorForApi,
  deriveDeploymentRunFailureClass,
  deriveDeploymentRunTerminalCause,
} from "./deployment-run-failure-class";

describe("deriveDeploymentRunFailureClass", () => {
  it("classifies clean zero-exit runs as success", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "succeeded",
      exitCode: 0,
      error: null,
      cleanupStatus: { scriptCompleted: true, flushExitCode: 0 },
    })).toBe("success");
  });

  it("classifies successful runs with bad cleanup as cleanup_warning", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "succeeded",
      exitCode: 0,
      error: null,
      cleanupStatus: { mountConfigured: true, scriptCompleted: true, flushExitCode: 1 },
    })).toBe("cleanup_warning");
  });

  it("does not classify failed zero-exit runs with errors as success", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 0,
      error: "runner reported a terminal failure despite exit 0",
      cleanupStatus: { scriptCompleted: true, flushExitCode: 0 },
    })).toBe("runner_error");
  });

  it("does not classify success-status runs with errors as success", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "succeeded",
      exitCode: 0,
      error: "runner reported an error after completion",
      cleanupStatus: { scriptCompleted: true, flushExitCode: 0 },
    })).toBe("runner_error");
  });

  it("classifies failed runs with cleanup problems as mount failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 1,
      error: null,
      cleanupStatus: { mountConfigured: true, scriptCompleted: true, flushExitCode: 1 },
    })).toBe("mount_failure");
  });

  it("preserves runner errors when cleanup also fails", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 1,
      error: "TypeError: boom",
      cleanupStatus: { mountConfigured: true, scriptCompleted: true, flushExitCode: 1 },
    })).toBe("runner_error");
  });

  it("classifies legacy missing bundle failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: null,
      error: "agent has no persisted bundle; redeploy under cold-start runtime",
    })).toBe("bundle_unavailable");
  });

  it("classifies dependency install and runtime bootstrap failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 1,
      error: "runner bootstrap failed",
      stdout: "npm install --omit=dev failed\n[proactive-runtime] runtime load failed",
    })).toBe("dep_install_failed");
  });

  it("classifies smithy diagnostics as dependency/runtime bootstrap failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 1,
      error: null,
      stdout: "[smithy-diag] node=v25.6.0\n[smithy-diag] cwd-resolve=/home/daytona/node_modules/@smithy/smithy-client/dist-cjs/index.js",
    })).toBe("dep_install_failed");
  });

  it("classifies relayfile mount failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 92,
      error: "Failed to flush relayfile mount",
      mountLogTail: "relayfile-mount --once timed out",
    })).toBe("mount_failure");
  });

  it("classifies delivery and sandbox bootstrap failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: null,
      error: "tick_delivery_failed: Deployment runtime does not support async run submission",
    })).toBe("bootstrap_failed");
  });

  it("classifies workflow token mint failures as bootstrap failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: null,
      error: "failed to mint workflow workspace token for deployment trigger: token service unavailable",
    })).toBe("bootstrap_failed");
  });

  it("falls back to runner_error for non-zero runner failures", () => {
    expect(deriveDeploymentRunFailureClass({
      status: "failed",
      exitCode: 1,
      error: "TypeError: cannot read properties of undefined",
      stdout: "runner.mjs failed",
    })).toBe("runner_error");
  });

  describe("writeback_undelivered (cloud#2029)", () => {
    it("is LOUD even when the run otherwise looks clean (exit 0, no error)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 124,
          pendingWriteback: 2,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("writeback_undelivered");
    });

    it("fires even when the teardown flush was rescued to exit 0", () => {
      // The -newer pending probe can be blind to an old backlog, rescuing the
      // flush to 0. The canonical pendingWriteback + this-run command draft
      // must still surface the drop.
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 1,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("writeback_undelivered");
    });

    it("does NOT fire on a read-only run that drafted no command (no false alarm; cloud#2013 preserved)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 124,
          pendingWriteback: 5,
          commandDraftWrittenThisRun: false,
        },
      })).toBe("cleanup_warning");
    });

    it("does NOT fire when a command draft was written but nothing is pending (delivered)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("success");
    });

    it("requires BOTH a command draft AND pending>0 — neither alone trips it", () => {
      // pending>0 alone (no draft this run) → not undelivered.
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          pendingWriteback: 3,
          commandDraftWrittenThisRun: false,
        },
      })).not.toBe("writeback_undelivered");
      // draft alone (pending 0) → not undelivered.
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          pendingWriteback: 0,
          commandDraftWrittenThisRun: true,
        },
      })).not.toBe("writeback_undelivered");
    });

    it("does NOT fire when the mount was not configured", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: false,
          scriptCompleted: true,
          pendingWriteback: 9,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("success");
    });

    it("takes precedence over a genuine runner error classification", () => {
      // An undelivered writeback is reported as writeback_undelivered even if
      // the run also failed — the dropped reply is the actionable signal.
      expect(deriveDeploymentRunFailureClass({
        status: "failed",
        exitCode: 124,
        error: "writeback_undelivered: ...",
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 124,
          pendingWriteback: 1,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("writeback_undelivered");
    });
  });

  describe("writeback_undelivered gate-widen (cloud#2029 follow-up #1)", () => {
    // Backward-compat: a REAL v0.8.19 mount emits hasPendingWriteback (= local
    // pendingWriteback>0), NOT absent keys. These prove no behavior change on
    // the CURRENTLY-DEPLOYED runner.
    it("(a1) real v0.8.19 pending shape (pendingWriteback>0 + hasPendingWriteback) → loud, same as the pre-widen gate", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 124,
          pendingWriteback: 2,
          hasPendingWriteback: true,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("writeback_undelivered");
    });

    it("(a2) real v0.8.19 delivered shape (pendingWriteback:0 + hasPendingWriteback:false) → silent", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          hasPendingWriteback: false,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("success");
    });

    it("(a3) genuinely-absent flags (older/garbage state.json) → backward-safe, not loud, no throw", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("success");
    });

    it("post-#264: outbox-pending surfaced via hasPendingWriteback with legacy pendingWriteback:0 → loud", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          hasPendingWriteback: true,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("writeback_undelivered");
    });

    it("post-#264: outboxNeedsAttention (retry budget exhausted) with everything else 0/false → loud", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          hasPendingWriteback: false,
          outboxNeedsAttention: true,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("writeback_undelivered");
    });

    it("the widened pending OR still requires a command draft (read-only stays silent)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          hasPendingWriteback: true,
          outboxNeedsAttention: true,
          commandDraftWrittenThisRun: false,
        },
      })).not.toBe("writeback_undelivered");
    });
  });

  describe("writeback_undelivered positive-receipt gate (cloud#2029 #1b)", () => {
    it("fires on undeliverable>0 EVEN WHEN the pending signals are all clear (closes the synced-but-undispatched gap rev_160432)", () => {
      // This is the gap the pending gate is blind to: the outbox uploaded
      // (pendingWriteback:0, no pending flags) but a this-run draft has no
      // positive adapter-dispatch receipt → it never reached Slack.
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          hasPendingWriteback: false,
          outboxNeedsAttention: false,
          commandDraftWrittenThisRun: true,
          commandDraftsUndeliverable: 1,
        },
      })).toBe("writeback_undelivered");
    });

    it("does NOT fire when undeliverable:0 and nothing pending (all delivered / benign in-flight → no false alarm)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          hasPendingWriteback: false,
          outboxNeedsAttention: false,
          commandDraftWrittenThisRun: true,
          commandDraftsUndeliverable: 0,
        },
      })).toBe("success");
    });

    it("keeps the pending signals as a secondary catch even when undeliverable:0", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          outboxNeedsAttention: true,
          commandDraftWrittenThisRun: true,
          commandDraftsUndeliverable: 0,
        },
      })).toBe("writeback_undelivered");
    });

    it("feature-detect: a pre-receipt mount (undeliverable absent → null) falls back to the pending gate (fires)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 124,
          pendingWriteback: 2,
          hasPendingWriteback: true,
          commandDraftWrittenThisRun: true,
          // commandDraftsUndeliverable intentionally absent (pre-PR2 mount)
        },
      })).toBe("writeback_undelivered");
    });

    it("feature-detect: pre-receipt mount with nothing pending stays silent (unchanged from today)", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          pendingWriteback: 0,
          hasPendingWriteback: false,
          commandDraftWrittenThisRun: true,
        },
      })).toBe("success");
    });

    it("still requires a this-run command draft — undeliverable>0 alone does not fire a read-only run", () => {
      expect(deriveDeploymentRunFailureClass({
        status: "succeeded",
        exitCode: 0,
        error: null,
        cleanupStatus: {
          mountConfigured: true,
          scriptCompleted: true,
          flushExitCode: 0,
          commandDraftWrittenThisRun: false,
          commandDraftsUndeliverable: 3,
        },
      })).not.toBe("writeback_undelivered");
    });
  });
});

describe("deploymentRunErrorForApi", () => {
  it("preserves existing error text", () => {
    expect(deploymentRunErrorForApi({
      status: "failed",
      exitCode: 1,
      error: "TypeError: boom",
      cleanupStatus: { mountConfigured: true, scriptCompleted: true, flushExitCode: 1 },
    })).toBe("TypeError: boom");
  });

  it("synthesizes cleanup failure text for failed rows with empty errors", () => {
    expect(deploymentRunErrorForApi({
      status: "failed",
      exitCode: 1,
      error: null,
      cleanupStatus: {
        mountConfigured: true,
        scriptCompleted: true,
        flushExitCode: 1,
        killExitCode: 0,
        pendingWriteback: 0,
        hasPendingWriteback: false,
        outboxNeedsAttention: false,
        commandDraftWrittenThisRun: false,
        commandDraftsUndeliverable: 0,
      },
    })).toBe("relayfile mount cleanup failed (flushExitCode=1)");
  });

  it("synthesizes a generic failure for empty failed rows without cleanup detail", () => {
    expect(deploymentRunErrorForApi({
      status: "failed",
      exitCode: 1,
      error: null,
      cleanupStatus: { mountConfigured: false, scriptCompleted: true, flushExitCode: 0 },
    })).toBe("deployment run exited with code 1 without a recorded error");
  });

  it("synthesizes a generic failure for failed rows without an exit code", () => {
    expect(deploymentRunErrorForApi({
      status: "failed",
      exitCode: null,
      error: "",
      cleanupStatus: { mountConfigured: false, scriptCompleted: true, flushExitCode: 0 },
    })).toBe("deployment run failed without a recorded error");
  });

  it("leaves successful rows without cleanup failures empty", () => {
    expect(deploymentRunErrorForApi({
      status: "succeeded",
      exitCode: 0,
      error: null,
      cleanupStatus: { mountConfigured: true, scriptCompleted: true, flushExitCode: 0 },
    })).toBeNull();
  });
});

describe("deriveDeploymentRunTerminalCause", () => {
  it("maps normalized writeback no-receipt errors to a headline cause", () => {
    expect(deriveDeploymentRunTerminalCause({
      status: "failed",
      exitCode: 1,
      error: "writeback_no_receipt:/.integrations/slack/channels/C123/messages/draft.json",
    })).toEqual({
      code: "writeback_no_receipt",
      headline: "writeback_no_receipt:/.integrations/slack/channels/C123/messages/draft.json",
      details: {
        path: "/.integrations/slack/channels/C123/messages/draft.json",
        failureClass: "runner_error",
      },
    });
  });

  it("maps normalized writeback validation failures to a headline cause", () => {
    expect(deriveDeploymentRunTerminalCause({
      status: "failed",
      exitCode: 1,
      error: "writeback_validation_failed:/.integrations/github/repos/o/r/issues/new.json",
    })).toMatchObject({
      code: "writeback_validation_failed",
      headline: "writeback_validation_failed:/.integrations/github/repos/o/r/issues/new.json",
      details: {
        path: "/.integrations/github/repos/o/r/issues/new.json",
      },
    });
  });

  it("maps JSON-shaped normalized writeback errors when present in logs", () => {
    expect(deriveDeploymentRunTerminalCause({
      status: "failed",
      exitCode: 1,
      error: null,
      stdout: JSON.stringify({
        state: "adapter_error",
        path: "/.integrations/notion/pages/page_123/comments.json/draft.json",
      }),
    })).toMatchObject({
      code: "writeback_adapter_error",
      headline: "writeback_adapter_error:/.integrations/notion/pages/page_123/comments.json/draft.json",
      details: {
        path: "/.integrations/notion/pages/page_123/comments.json/draft.json",
      },
    });
  });

  it("maps JSON-shaped normalized writeback errors when path appears before state", () => {
    expect(deriveDeploymentRunTerminalCause({
      status: "failed",
      exitCode: 1,
      error: null,
      stdout: JSON.stringify({
        path: "/.integrations/notion/pages/page_123/comments.json/draft.json",
        state: "adapter_error",
      }),
    })).toMatchObject({
      code: "writeback_adapter_error",
      headline: "writeback_adapter_error:/.integrations/notion/pages/page_123/comments.json/draft.json",
      details: {
        path: "/.integrations/notion/pages/page_123/comments.json/draft.json",
      },
    });
  });

  it("does not let handled writeback markers override successful terminal outcomes", () => {
    expect(deriveDeploymentRunTerminalCause({
      status: "succeeded",
      exitCode: 0,
      error: null,
      stdout: "handled writeback_no_receipt:/.integrations/slack/channels/C123/messages/draft.json",
    })).toEqual({
      code: "completed",
      headline: "completed",
      details: {
        failureClass: "success",
      },
    });
  });

  it("falls back to timeout causes for timed out handlers", () => {
    expect(deriveDeploymentRunTerminalCause({
      status: "failed",
      exitCode: 124,
      error: "handler timed out after 30000ms",
    })).toEqual({
      code: "timeout",
      headline: "timeout",
      details: {
        failureClass: "runner_error",
      },
    });
  });
});
