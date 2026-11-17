import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "../baseSchemas.ts";
import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "../threadPullRequest.ts";
import {
  deriveWorkTaskStatus,
  WORK_TASK_STATUS_URGENCY,
  WORK_TASK_STATUSES,
  workTaskPullRequestFromSnapshot,
  workTaskSection,
  workTaskStatusInputs,
  workTaskThreadState,
  type WorkTaskPullRequestView,
  type WorkTaskSection,
  type WorkTaskStatus,
  type WorkTaskStatusShell,
  type WorkTaskStatusTask,
  type WorkTaskStatusThread,
} from "./workTaskStatus.ts";
import type { WorkTaskPullRequestFacts } from "./workTaskInsights.ts";
import { WorkTaskId, type WorkTaskLegacyPullRequest } from "./workTasks.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const BRANCH = "feature/widgets";

function pullRequest(overrides: Partial<WorkTaskPullRequestView> = {}): WorkTaskPullRequestView {
  return {
    state: "open",
    checks: "none",
    review: "none",
    mergeConflicts: false,
    unresolvedComments: 0,
    ...overrides,
  };
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
  const monitoring: WorkTaskStatusThread = { origin: "user", state: "monitoring" };

  it("1. puts archived above everything", () => {
    expect(status(task({ archivedAt: NOW, mergedAt: NOW }), [waiting, reviewRunning])).toBe(
      "archived",
    );
  });

  it("2-3. reports setup above the user, agents and the pull request", () => {
    const setup = (s: "pending" | "running" | "failed") =>
      task({
        workspace: { branch: BRANCH, setup: { status: s } },
        waitingForUserReason: "Pick a base",
      });
    expect(status(setup("pending"), [running])).toBe("setting-up");
    expect(status(setup("running"), [])).toBe("setting-up");
    expect(status(setup("failed"), [running])).toBe("setup-failed");
  });

  it("4. waits for the user on a reason or a blocked thread, above automated work", () => {
    expect(status(task({ waitingForUserReason: "Approve the plan" }), [])).toBe("waiting-for-user");
    expect(status(task({ mergedAt: NOW }), [waiting])).toBe("waiting-for-user");
    expect(status(task(), [reviewRunning, waiting], pullRequest({ mergeConflicts: true }))).toBe(
      "waiting-for-user",
    );
  });

  it("5. shows an automated review thread above requested changes", () => {
    const pr = pullRequest({ review: "changes-requested", mergeConflicts: true });
    expect(status(task(), [reviewRunning], pr)).toBe("addressing-comments");
  });

  it("6. is merged once merged, or monitoring while a thread still runs", () => {
    const failingMerged = pullRequest({ state: "merged", checks: "failing" });
    expect(status(task({ mergedAt: NOW }), [idle])).toBe("merged");
    expect(status(task(), [idle], failingMerged)).toBe("merged");
    expect(status(task(), [running], pullRequest({ state: "merged" }))).toBe("monitoring");
    expect(status(task({ mergedAt: NOW }), [monitoring])).toBe("monitoring");
  });

  it("7. ranks merge conflicts above a running thread", () => {
    expect(status(task(), [running], pullRequest({ mergeConflicts: true }))).toBe(
      "merge-conflicts",
    );
    expect(
      status(task(), [], pullRequest({ mergeConflicts: true, review: "changes-requested" })),
    ).toBe("merge-conflicts");
    expect(status(task(), [], pullRequest({ state: "draft", mergeConflicts: true }))).toBe(
      "merge-conflicts",
    );
  });

  it("8. ranks requested changes above unresolved comments and a running thread", () => {
    const pr = pullRequest({ review: "changes-requested", unresolvedComments: 2 });
    expect(status(task(), [running], pr)).toBe("changes-requested");
  });

  it("9. ranks unresolved comments above failing approved checks", () => {
    const pr = pullRequest({ review: "approved", checks: "failing", unresolvedComments: 1 });
    expect(status(task(), [running], pr)).toBe("unresolved-comments");
  });

  it("10. surfaces failing checks only on an approved pull request", () => {
    expect(status(task(), [], pullRequest({ review: "approved", checks: "failing" }))).toBe(
      "approved-checks-failing",
    );
    expect(status(task(), [], pullRequest({ review: "pending", checks: "failing" }))).toBe(
      "waiting-for-review",
    );
  });

  it("11. is working while a thread runs, even with pending checks", () => {
    expect(status(task(), [running], pullRequest())).toBe("working");
    expect(status(task(), [monitoring, running])).toBe("working");
    expect(status(task(), [running], pullRequest({ state: "draft" }))).toBe("working");
  });

  it("12. monitors while only watch loops run", () => {
    expect(status(task(), [idle, monitoring])).toBe("monitoring");
  });

  it("13-14. derives approval and review of an open pull request", () => {
    const of = (pr: Partial<WorkTaskPullRequestView>) => status(task(), [idle], pullRequest(pr));
    expect(of({ review: "approved", checks: "passing" })).toBe("approved");
    expect(of({ review: "approved", checks: "pending" })).toBe("approved");
    expect(of({ review: "approved", checks: "none" })).toBe("approved");
    expect(of({ review: "pending", checks: "pending" })).toBe("waiting-for-review");
    expect(of({ review: "none", checks: "passing" })).toBe("waiting-for-review");
  });

  it("15. is idle when nothing runs, on a draft or a closed pull request too", () => {
    expect(status(task(), [fresh, idle])).toBe("idle");
    expect(status(task(), [])).toBe("idle");
    expect(status(task(), [idle], pullRequest({ state: "draft", review: "approved" }))).toBe(
      "idle",
    );
    expect(
      status(
        task(),
        [idle],
        pullRequest({ state: "closed", checks: "failing", mergeConflicts: true }),
      ),
    ).toBe("idle");
  });
});

describe("workTaskSection", () => {
  const SECTIONS: Record<WorkTaskSection, ReadonlyArray<WorkTaskStatus>> = {
    attention: [
      "setup-failed",
      "waiting-for-user",
      "idle",
      "merge-conflicts",
      "changes-requested",
      "unresolved-comments",
      "approved-checks-failing",
    ],
    working: ["setting-up", "working", "addressing-comments", "monitoring"],
    review: ["waiting-for-review", "approved"],
    done: ["merged", "archived"],
  };

  it("places every status in exactly one section", () => {
    const listed = Object.values(SECTIONS).flat();
    expect([...listed].sort()).toEqual([...WORK_TASK_STATUSES].sort());
    for (const [section, statuses] of Object.entries(SECTIONS)) {
      for (const s of statuses) expect(workTaskSection(s, false)).toBe(section);
    }
  });

  it("raises an unseen task to attention unless it is working", () => {
    for (const s of WORK_TASK_STATUSES) {
      expect(workTaskSection(s, true)).toBe(SECTIONS.working.includes(s) ? "working" : "attention");
    }
  });
});

describe("WORK_TASK_STATUS_URGENCY", () => {
  it("lists every status once, in rule order", () => {
    expect([...WORK_TASK_STATUS_URGENCY].sort()).toEqual([...WORK_TASK_STATUSES].sort());
    expect(WORK_TASK_STATUS_URGENCY.indexOf("merge-conflicts")).toBeLessThan(
      WORK_TASK_STATUS_URGENCY.indexOf("changes-requested"),
    );
    expect(WORK_TASK_STATUS_URGENCY.indexOf("working")).toBeLessThan(
      WORK_TASK_STATUS_URGENCY.indexOf("approved"),
    );
    expect(WORK_TASK_STATUS_URGENCY.at(-1)).toBe("idle");
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
    const question = (blocking: boolean) => ({
      id: "req" as never,
      kind: "user_input" as const,
      createdAt: undefined as never,
      blocking,
    });
    // A non-blocking question while the run works is not a wait; once the run stops it is.
    expect(
      workTaskThreadState(
        shell("t", { ...ran, status: "running", pendingRuntimeRequest: question(false) }),
      ),
    ).toBe("running");
    expect(
      workTaskThreadState(shell("t", { ...ran, pendingRuntimeRequest: question(false) })),
    ).toBe("waiting");
    expect(
      workTaskThreadState(
        shell("t", { ...ran, status: "running", pendingRuntimeRequest: question(true) }),
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

const facts = (overrides: Partial<WorkTaskPullRequestFacts> = {}): WorkTaskPullRequestFacts => ({
  number: 7 as never,
  review: "none",
  checks: "none",
  mergeConflicts: false,
  unresolvedComments: 0,
  syncedAt: NOW,
  ...overrides,
});

describe("workTaskPullRequestFromSnapshot", () => {
  const from = (snap: ThreadPullRequestSnapshot, f: WorkTaskPullRequestFacts | null = null) =>
    workTaskPullRequestFromSnapshot(snap, f);

  it("maps draft, closed, null checks and review-required", () => {
    expect(from(snapshot())).toEqual({
      state: "open",
      checks: "none",
      review: "none",
      mergeConflicts: false,
      unresolvedComments: 0,
    });
    expect(from(snapshot({ isDraft: true })).state).toBe("draft");
    expect(from(snapshot({ state: "closed" })).state).toBe("closed");
    expect(from(snapshot({ state: "merged" })).state).toBe("merged");
    expect(from(snapshot({ checksState: null })).checks).toBe("none");
    expect(from(snapshot({ checksState: "failing" })).checks).toBe("failing");
    expect(from(snapshot({ reviewDecision: "review-required" })).review).toBe("pending");
    expect(from(snapshot({ reviewDecision: "approved" })).review).toBe("approved");
    expect(from(snapshot({ mergeability: "conflicting" })).mergeConflicts).toBe(true);
  });

  it("lets facts override review and checks and add conflicts and comments", () => {
    const snap = snapshot({ reviewDecision: "approved", checksState: "passing" });
    expect(
      from(
        snap,
        facts({
          review: "changes-requested",
          checks: "failing",
          mergeConflicts: true,
          unresolvedComments: 3,
        }),
      ),
    ).toEqual({
      state: "open",
      checks: "failing",
      review: "changes-requested",
      mergeConflicts: true,
      unresolvedComments: 3,
    });
    // A conflicting snapshot stays conflicting even when facts say otherwise.
    expect(from(snapshot({ mergeability: "conflicting" }), facts()).mergeConflicts).toBe(true);
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

  it("ignores fork children, which share the root and copy its pull requests", () => {
    const fork = shell("fork", {
      ...ran,
      status: "running",
      lineage: {
        rootThreadId: threadId("review"),
        parentThreadId: threadId("review"),
        relationshipToParent: "fork",
      },
      pullRequests: [prLink(snapshot({ reviewDecision: "approved" }))],
    });
    expect(derive([shell("a", ran), fork])).toBe("idle");
    expect(
      workTaskStatusInputs({ taskId, task: task(), links, shells: [shell("a", ran), fork] }),
    ).toEqual({ threads: [{ origin: "user", state: "idle" }], pullRequest: null });
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
    expect(derive([shell("a", ran)], withLegacy)).toBe("approved");

    const other = snapshot({ headBranch: "elsewhere", reviewDecision: "changes-requested" });
    const ours = snapshot({ checksState: "pending" });
    const a = shell("a", {
      ...ran,
      pullRequests: [prLink(other, NOW, 1), prLink(ours, NOW, 2), prLink(null, NOW, 3)],
    });
    expect(derive([a], withLegacy)).toBe("waiting-for-review");
    expect(
      workTaskStatusInputs({ taskId, task: withLegacy, links, shells: [a] }).pullRequest,
    ).toEqual({
      state: "open",
      checks: "pending",
      review: "none",
      mergeConflicts: false,
      unresolvedComments: 0,
    });
  });

  it("passes facts through to the linked snapshot, but not to the legacy row", () => {
    const a = shell("a", { ...ran, pullRequests: [prLink(snapshot())] });
    const withFacts = facts({ review: "approved", checks: "failing" });
    expect(
      deriveWorkTaskStatus({
        task: task(),
        ...workTaskStatusInputs({ taskId, task: task(), links, shells: [a], facts: withFacts }),
      }),
    ).toBe("approved-checks-failing");
    const legacy = { state: "open", checks: "none", review: "none" } as WorkTaskLegacyPullRequest;
    expect(
      workTaskStatusInputs({
        taskId,
        task: task({ legacyPullRequest: legacy }),
        links,
        shells: [shell("a", ran)],
        facts: facts({ unresolvedComments: 2 }),
      }).pullRequest,
    ).toEqual({
      state: "open",
      checks: "none",
      review: "none",
      mergeConflicts: false,
      unresolvedComments: 0,
    });
  });
});
