import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "../baseSchemas.ts";
import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "../threadPullRequest.ts";
import {
  deriveWorkTaskStatus,
  workTaskPullRequestFromSnapshot,
  workTaskStatusInputs,
  workTaskThreadState,
  type WorkTaskPullRequestView,
  type WorkTaskStatusShell,
  type WorkTaskStatusTask,
  type WorkTaskStatusThread,
} from "./workTaskStatus.ts";
import { WorkTaskId, type WorkTaskLegacyPullRequest } from "./workTasks.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const BRANCH = "feature/widgets";

function pullRequest(overrides: Partial<WorkTaskPullRequestView> = {}): WorkTaskPullRequestView {
  return { state: "open", checks: "none", review: "none", ...overrides };
}

function task(overrides: Partial<WorkTaskStatusTask> = {}): WorkTaskStatusTask {
  return {
    archivedAt: null,
    mergedAt: null,
    waitingForUserReason: null,
    legacyPullRequest: null,
    workspace: { branch: BRANCH, setup: { status: "ready" } },
    ...overrides,
  };
}

const status = (
  t: WorkTaskStatusTask,
  threads: ReadonlyArray<WorkTaskStatusThread>,
  pr: WorkTaskPullRequestView | null = null,
) => deriveWorkTaskStatus({ task: t, threads, pullRequest: pr });

const running: WorkTaskStatusThread = { origin: "user", state: "running" };
const reviewRunning: WorkTaskStatusThread = { origin: "review-feedback", state: "running" };
const waiting: WorkTaskStatusThread = { origin: null, state: "waiting" };
const idle: WorkTaskStatusThread = { origin: null, state: "idle" };
const fresh: WorkTaskStatusThread = { origin: "user", state: "new" };

describe("deriveWorkTaskStatus", () => {
  it("puts archived above everything, then merged", () => {
    const busy = [waiting, reviewRunning];
    expect(status(task({ archivedAt: NOW, mergedAt: NOW }), busy)).toBe("archived");
    expect(status(task({ mergedAt: NOW }), busy)).toBe("merged");
    expect(status(task(), busy, pullRequest({ state: "merged" }))).toBe("merged");
  });

  it("reports setup before agent and pull request state", () => {
    const setup = (s: "pending" | "running" | "failed") =>
      task({
        workspace: { branch: BRANCH, setup: { status: s } },
        waitingForUserReason: "Pick a base",
      });
    expect(status(setup("pending"), [running])).toBe("setting-up");
    expect(status(setup("running"), [])).toBe("setting-up");
    expect(status(setup("failed"), [running])).toBe("setup-failed");
  });

  it("waits for the user on a reason or a blocked thread, above automated work", () => {
    expect(status(task({ waitingForUserReason: "Approve the plan" }), [])).toBe("waiting-for-user");
    expect(status(task(), [reviewRunning, waiting], pullRequest({ checks: "failing" }))).toBe(
      "waiting-for-user",
    );
  });

  it("shows an automated review thread above failing checks", () => {
    const failing = pullRequest({ checks: "failing", review: "changes-requested" });
    expect(status(task(), [reviewRunning], failing)).toBe("addressing-comments");
    expect(status(task(), [running], failing)).toBe("ci-failing");
  });

  it("ranks requested changes above a running user thread", () => {
    expect(status(task(), [running], pullRequest({ review: "changes-requested" }))).toBe(
      "changes-requested",
    );
    expect(status(task(), [running], pullRequest())).toBe("working");
  });

  it("derives the review lifecycle of an open pull request", () => {
    const of = (pr: Partial<WorkTaskPullRequestView>) => status(task(), [idle], pullRequest(pr));
    expect(of({ review: "approved", checks: "passing" })).toBe("merge-ready");
    expect(of({ review: "approved", checks: "none" })).toBe("merge-ready");
    expect(of({ review: "approved", checks: "pending" })).toBe("approved");
    expect(of({ review: "pending", checks: "pending" })).toBe("ci-running");
    expect(of({ review: "pending", checks: "passing" })).toBe("waiting-for-review");
    expect(of({ state: "draft" })).toBe("waiting-for-review");
  });

  it("treats a closed pull request like no pull request", () => {
    expect(status(task(), [idle], pullRequest({ state: "closed", checks: "failing" }))).toBe(
      "idle",
    );
  });

  it("monitors while only watch loops run, below running agents", () => {
    const monitoring: WorkTaskStatusThread = { origin: "user", state: "monitoring" };
    expect(status(task(), [idle, monitoring])).toBe("monitoring");
    expect(status(task(), [monitoring, running])).toBe("working");
  });

  it("is idle whenever nothing is running, even before any agent worked", () => {
    expect(status(task(), [fresh, idle])).toBe("idle");
    expect(status(task(), [fresh])).toBe("idle");
    expect(status(task(), [])).toBe("idle");
  });
});

const threadId = (id: string) => ThreadId.make(id);

function shell(id: string, overrides: Partial<WorkTaskStatusShell> = {}): WorkTaskStatusShell {
  return {
    id: threadId(id),
    lineage: { rootThreadId: threadId(id), parentThreadId: null, relationshipToParent: null },
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    pullRequests: [],
    ...overrides,
  };
}

const ran = { latestRunId: "run-1" } as unknown as Partial<WorkTaskStatusShell>;

describe("workTaskThreadState", () => {
  it("maps a V2 shell to a thread state", () => {
    expect(workTaskThreadState(shell("t"))).toBe("new");
    expect(workTaskThreadState(shell("t", ran))).toBe("idle");
    expect(workTaskThreadState(shell("t", { ...ran, status: "running" }))).toBe("running");
    expect(workTaskThreadState(shell("t", { ...ran, status: "queued" }))).toBe("running");
    expect(
      workTaskThreadState(
        shell("t", {
          ...ran,
          status: "running",
          pendingRuntimeRequest: {
            id: "req" as never,
            kind: "approval" as never,
            createdAt: undefined as never,
          },
        }),
      ),
    ).toBe("waiting");
    expect(
      workTaskThreadState(
        shell("t", { ...ran, pendingBackgroundTasks: [{ kind: "monitor" } as never] }),
      ),
    ).toBe("monitoring");
  });
});

const snapshot = (
  overrides: Partial<ThreadPullRequestSnapshot> = {},
): ThreadPullRequestSnapshot => ({
  state: "open",
  title: "Add widgets",
  headBranch: BRANCH,
  baseBranch: "main",
  isDraft: false,
  updatedAt: null,
  syncedAt: NOW,
  ...overrides,
});

describe("workTaskPullRequestFromSnapshot", () => {
  it("maps draft, closed, null checks and review-required", () => {
    expect(workTaskPullRequestFromSnapshot(snapshot())).toEqual({
      state: "open",
      checks: "none",
      review: "none",
    });
    expect(workTaskPullRequestFromSnapshot(snapshot({ isDraft: true })).state).toBe("draft");
    expect(workTaskPullRequestFromSnapshot(snapshot({ state: "closed" })).state).toBe("closed");
    expect(workTaskPullRequestFromSnapshot(snapshot({ state: "merged" })).state).toBe("merged");
    expect(workTaskPullRequestFromSnapshot(snapshot({ checksState: null })).checks).toBe("none");
    expect(workTaskPullRequestFromSnapshot(snapshot({ checksState: "failing" })).checks).toBe(
      "failing",
    );
    expect(
      workTaskPullRequestFromSnapshot(snapshot({ reviewDecision: "review-required" })).review,
    ).toBe("pending");
    expect(workTaskPullRequestFromSnapshot(snapshot({ reviewDecision: "approved" })).review).toBe(
      "approved",
    );
  });
});

const prLink = (
  snap: ThreadPullRequestSnapshot | null,
  linkedAt = NOW,
  number = 7,
): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/app",
  number: number as never,
  url: `https://github.com/acme/app/pull/${number}`,
  source: "agent",
  linkedAt,
  snapshot: snap,
  stack: null,
});

describe("workTaskStatusInputs", () => {
  const taskId = WorkTaskId.make("task-1");
  const links = [
    { threadId: threadId("a"), taskId, origin: "user" as const },
    { threadId: threadId("review"), taskId, origin: "review-feedback" as const },
    { threadId: threadId("other"), taskId: WorkTaskId.make("task-2"), origin: null },
  ];

  const derive = (shells: ReadonlyArray<WorkTaskStatusShell>, t = task()) =>
    deriveWorkTaskStatus({ task: t, ...workTaskStatusInputs({ taskId, task: t, links, shells }) });

  it("counts a running subagent child of a task thread as working", () => {
    const child = shell("child", {
      ...ran,
      status: "running",
      lineage: {
        rootThreadId: threadId("a"),
        parentThreadId: threadId("a"),
        relationshipToParent: "subagent",
      },
    });
    expect(derive([shell("a", ran), child])).toBe("working");
    // Threads of other tasks never count.
    expect(derive([shell("a", ran), shell("other", { ...ran, status: "running" })])).toBe("idle");
  });

  it("shows a running review-feedback thread as addressing comments", () => {
    expect(derive([shell("a", ran), shell("review", { ...ran, status: "running" })])).toBe(
      "addressing-comments",
    );
  });

  it("reads the pull request from linked shells on the task branch, else the legacy row", () => {
    const legacy = {
      state: "open",
      checks: "passing",
      review: "approved",
    } as WorkTaskLegacyPullRequest;
    const withLegacy = task({ legacyPullRequest: legacy });
    expect(derive([shell("a", ran)], withLegacy)).toBe("merge-ready");

    const other = snapshot({ headBranch: "elsewhere", reviewDecision: "changes-requested" });
    const ours = snapshot({ checksState: "pending" });
    const a = shell("a", {
      ...ran,
      pullRequests: [prLink(other, NOW, 1), prLink(ours, NOW, 2), prLink(null, NOW, 3)],
    });
    expect(derive([a], withLegacy)).toBe("ci-running");
    expect(
      workTaskStatusInputs({ taskId, task: withLegacy, links, shells: [a] }).pullRequest,
    ).toEqual({ state: "open", checks: "pending", review: "none" });
  });
});
