import type { OrchestrationTaskPullRequest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveTaskStatus,
  TASK_STATUS_PRESENTATION,
  TASK_STATUSES,
  type TaskStatusTask,
  type TaskStatusThread,
} from "./taskStatus.ts";

const NOW = "2026-10-01T12:00:00.000Z";

function pullRequest(
  overrides: Partial<OrchestrationTaskPullRequest> = {},
): OrchestrationTaskPullRequest {
  return {
    provider: "github",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Add widgets",
    state: "open",
    headBranch: "feature/widgets",
    baseBranch: "main",
    checks: "none",
    review: "none",
    linkedAt: NOW,
    observedAt: NOW,
    ...overrides,
  };
}

function task(overrides: Partial<TaskStatusTask> = {}): TaskStatusTask {
  return {
    archivedAt: null,
    mergedAt: null,
    waitingForUserReason: null,
    pullRequest: null,
    workspace: { setup: { status: "ready" } },
    ...overrides,
  };
}

const running: TaskStatusThread = { origin: "user", state: "running" };
const reviewRunning: TaskStatusThread = { origin: "review-feedback", state: "running" };
const waiting: TaskStatusThread = { origin: null, state: "waiting" };
const idle: TaskStatusThread = { origin: undefined, state: "idle" };
const fresh: TaskStatusThread = { origin: "user", state: "new" };

describe("deriveTaskStatus", () => {
  it("puts archived above everything, then merged", () => {
    const busy = [waiting, reviewRunning];
    expect(
      deriveTaskStatus({ task: task({ archivedAt: NOW, mergedAt: NOW }), threads: busy }),
    ).toBe("archived");
    expect(deriveTaskStatus({ task: task({ mergedAt: NOW }), threads: busy })).toBe("merged");
    expect(
      deriveTaskStatus({
        task: task({ pullRequest: pullRequest({ state: "merged" }) }),
        threads: busy,
      }),
    ).toBe("merged");
  });

  it("reports setup before agent and pull request state", () => {
    const setup = (status: "pending" | "running" | "failed") =>
      task({ workspace: { setup: { status } }, waitingForUserReason: "Pick a base" });
    expect(deriveTaskStatus({ task: setup("pending"), threads: [running] })).toBe("setting-up");
    expect(deriveTaskStatus({ task: setup("running"), threads: [] })).toBe("setting-up");
    expect(deriveTaskStatus({ task: setup("failed"), threads: [running] })).toBe("setup-failed");
  });

  it("waits for the user on a reason or a blocked thread, above automated work", () => {
    expect(
      deriveTaskStatus({ task: task({ waitingForUserReason: "Approve the plan" }), threads: [] }),
    ).toBe("waiting-for-user");
    expect(
      deriveTaskStatus({
        task: task({ pullRequest: pullRequest({ checks: "failing" }) }),
        threads: [reviewRunning, waiting],
      }),
    ).toBe("waiting-for-user");
  });

  it("shows an automated review thread above failing checks", () => {
    const failing = task({
      pullRequest: pullRequest({ checks: "failing", review: "changes-requested" }),
    });
    expect(deriveTaskStatus({ task: failing, threads: [reviewRunning] })).toBe(
      "addressing-comments",
    );
    expect(deriveTaskStatus({ task: failing, threads: [running] })).toBe("ci-failing");
  });

  it("ranks requested changes above a running user thread", () => {
    const changes = task({ pullRequest: pullRequest({ review: "changes-requested" }) });
    expect(deriveTaskStatus({ task: changes, threads: [running] })).toBe("changes-requested");
    expect(
      deriveTaskStatus({ task: task({ pullRequest: pullRequest() }), threads: [running] }),
    ).toBe("working");
  });

  it("derives the review lifecycle of an open pull request", () => {
    const status = (pr: Partial<OrchestrationTaskPullRequest>) =>
      deriveTaskStatus({ task: task({ pullRequest: pullRequest(pr) }), threads: [idle] });
    expect(status({ review: "approved", checks: "passing" })).toBe("merge-ready");
    expect(status({ review: "approved", checks: "none" })).toBe("merge-ready");
    expect(status({ review: "approved", checks: "pending" })).toBe("approved");
    expect(status({ review: "pending", checks: "pending" })).toBe("ci-running");
    expect(status({ review: "pending", checks: "passing" })).toBe("waiting-for-review");
    expect(status({ state: "draft" })).toBe("waiting-for-review");
  });

  it("treats a closed pull request like no pull request", () => {
    const closed = task({ pullRequest: pullRequest({ state: "closed", checks: "failing" }) });
    expect(deriveTaskStatus({ task: closed, threads: [idle] })).toBe("idle");
  });

  it("is idle when nothing is running, including before the first turn", () => {
    expect(deriveTaskStatus({ task: task(), threads: [fresh, idle] })).toBe("idle");
    expect(deriveTaskStatus({ task: task(), threads: [fresh] })).toBe("idle");
    expect(deriveTaskStatus({ task: task(), threads: [] })).toBe("idle");
  });
});

describe("TASK_STATUS_PRESENTATION", () => {
  it("gives every status a label and a distinct glyph", () => {
    const icons = TASK_STATUSES.map((status) =>
      JSON.stringify(TASK_STATUS_PRESENTATION[status].glyph),
    );
    expect(new Set(icons).size).toBe(TASK_STATUSES.length);
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_PRESENTATION[status].label.length).toBeGreaterThan(0);
    }
  });
});
