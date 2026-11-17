import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  WORK_TASK_STATUSES,
  WorkTaskId,
  type ThreadPullRequestLink,
  type WorkTaskLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkTaskViews,
  groupWorkTaskboard,
  linkedWorkTasksByKey,
  loadedWorkTasks,
  remoteBranchOf,
  threadsOutsideWorkTasks,
  workTaskboardColumnForStatus,
  workTaskKey,
  workTaskItemMenuItems,
  workTaskOwnsWorktreePath,
  workTaskTabState,
  workTaskThreadKeys,
  workTaskTitleFromBranch,
  type EnvironmentWorkTask,
  type WorkTaskView,
} from "./logic";
import type { WorkTaskItem } from "./grouping";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";
import { ENV, link, shell, workTask } from "./testFixtures";

function views(
  tasks: ReadonlyArray<EnvironmentWorkTask>,
  links: ReadonlyArray<WorkTaskLink>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
) {
  return buildWorkTaskViews({ tasks, linksByEnvironment: new Map([[ENV, links]]), shells });
}

function view(map: ReadonlyMap<string, WorkTaskView>, id: string): WorkTaskView {
  return map.get(workTaskKey(ENV, WorkTaskId.make(id)))!;
}

describe("buildWorkTaskViews", () => {
  it("keeps the task's live linked threads as tabs in creation order", () => {
    const result = views(
      [workTask({ id: "t" })],
      [link("b", "t"), link("a", "t"), link("gone", "t"), link("other", "t2")],
      [
        shell({ id: "b", createdAt: "2026-10-01T11:00:00.000Z" }),
        shell({ id: "a", createdAt: "2026-10-01T10:00:00.000Z" }),
        shell({ id: "gone", archivedAt: "2026-10-01T12:00:00.000Z" }),
        shell({ id: "other" }),
        shell({ id: "child", subagentOf: "a" }),
      ],
    );
    expect(view(result, "t").tabs.map((tab) => tab.shell.id)).toEqual(["a", "b"]);
  });

  it("counts subagent work, reads a new task as idle and review work as addressing comments", () => {
    const result = views(
      [workTask({ id: "sub" }), workTask({ id: "fresh" }), workTask({ id: "review" })],
      [link("p", "sub"), link("n", "fresh"), link("r", "review", "review-feedback")],
      [
        shell({ id: "p", ran: true }),
        shell({ id: "c", subagentOf: "p", running: true }),
        shell({ id: "n" }),
        shell({ id: "r", running: true }),
      ],
    );
    expect(view(result, "sub").status).toBe("working");
    expect(view(result, "fresh").status).toBe("idle");
    expect(view(result, "review").status).toBe("addressing-comments");
  });

  it("lands on the most recently active tab and reports activity from it", () => {
    const result = views(
      [workTask({ id: "t", updatedAt: "2026-10-01T09:30:00.000Z" })],
      [link("a", "t"), link("b", "t")],
      [
        shell({ id: "a", latestUserMessageAt: "2026-10-01T10:00:00.000Z" }),
        shell({ id: "b", latestUserMessageAt: "2026-10-01T11:00:00.000Z" }),
      ],
    );
    expect(view(result, "t").latestThread?.id).toBe("b");
    expect(view(result, "t").activityAt).toBe("2026-10-01T11:00:00.000Z");
  });

  it("takes the pull request on the task branch from a thread link", () => {
    const pr = (number: number, headBranch: string, linkedAt: string) =>
      ({
        host: "github.com",
        repository: "o/r",
        number,
        url: `https://github.com/o/r/pull/${number}`,
        source: "agent",
        linkedAt,
        stack: null,
        snapshot: {
          state: "open",
          title: `PR ${number}`,
          headBranch,
          baseBranch: "main",
          isDraft: number === 8,
          updatedAt: null,
          syncedAt: linkedAt,
          checksState: "pending",
          reviewDecision: "approved",
        },
      }) as ThreadPullRequestLink;
    const result = views(
      [workTask({ id: "t", branch: "feature/x" })],
      [link("a", "t")],
      [
        shell({
          id: "a",
          ran: true,
          pullRequests: [
            pr(7, "feature/x", "2026-10-01T10:00:00.000Z"),
            pr(8, "feature/x", "2026-10-01T11:00:00.000Z"),
            pr(9, "other", "2026-10-01T12:00:00.000Z"),
          ],
        }),
      ],
    );
    expect(view(result, "t").pullRequest).toMatchObject({ number: 8, state: "draft" });
    expect(view(result, "t").status).toBe("idle");
  });

  it("applies insight facts to the matching PR only", () => {
    const pr = (number: number) =>
      ({
        host: "github.com",
        repository: "acme/app",
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        source: "agent",
        linkedAt: "2026-10-01T10:00:00.000Z",
        stack: null,
        snapshot: {
          state: "open",
          title: "t",
          headBranch: "feature/x",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-01T10:00:00.000Z",
          checksState: "pending",
          reviewDecision: "approved",
        },
      }) as ThreadPullRequestLink;
    const facts = (number: number) => ({
      taskId: WorkTaskId.make("t"),
      workItem: null,
      pullRequest: {
        number: number as never,
        review: "approved" as const,
        checks: "none" as const,
        mergeConflicts: true,
        unresolvedComments: 0,
        syncedAt: "2026-10-01T10:00:00.000Z" as never,
      },
    });
    const build = (number: number) =>
      buildWorkTaskViews({
        tasks: [workTask({ id: "t", branch: "feature/x" })],
        linksByEnvironment: new Map([[ENV, [link("a", "t")]]]),
        shells: [shell({ id: "a", ran: true, pullRequests: [pr(7)] })],
        insights: new Map([[workTaskKey(ENV, WorkTaskId.make("t")), facts(number)]]),
      });
    expect(view(build(7), "t").status).toBe("merge-conflicts");
    expect(view(build(8), "t").status).toBe("approved");
  });
});

describe("workTaskTabState", () => {
  it("shows settled idle threads as completed and live work as is", () => {
    expect(workTaskTabState(shell({ id: "a", ran: true }))).toBe("idle");
    expect(
      workTaskTabState(shell({ id: "a", ran: true, settledAt: "2026-10-01T12:00:00.000Z" })),
    ).toBe("completed");
    expect(workTaskTabState(shell({ id: "a", running: true }))).toBe("running");
    expect(workTaskTabState(shell({ id: "a", ran: true, monitoring: true }))).toBe("monitoring");
    expect(workTaskTabState(shell({ id: "a", running: true, waiting: true }))).toBe("waiting");
  });
});

describe("workTaskboardColumnForStatus", () => {
  it("maps every status to its column", () => {
    expect(
      Object.fromEntries(
        WORK_TASK_STATUSES.map((status) => [status, workTaskboardColumnForStatus(status)]),
      ),
    ).toEqual({
      "setting-up": "working",
      "setup-failed": "needs-you",
      working: "working",
      monitoring: "working",
      "waiting-for-user": "needs-you",
      idle: "working",
      "merge-conflicts": "needs-you",
      "changes-requested": "needs-you",
      "unresolved-comments": "needs-you",
      "approved-checks-failing": "needs-you",
      "addressing-comments": "working",
      "waiting-for-review": "in-review",
      approved: "ready-to-merge",
      merged: "merged",
      archived: "archive",
    });
  });
});

describe("groupWorkTaskboard", () => {
  it("puts one card per task in its column, most recently active first", () => {
    const result = views(
      [
        workTask({ id: "quiet", updatedAt: "2026-10-01T10:00:00.000Z" }),
        workTask({ id: "busy", updatedAt: "2026-10-01T08:00:00.000Z" }),
        workTask({ id: "blocked", waitingForUserReason: "Pick a library" }),
        workTask({ id: "old", archivedAt: "2026-10-01T12:00:00.000Z" }),
      ],
      [link("t1", "busy"), link("t2", "busy")],
      [
        shell({ id: "t1", ran: true, latestUserMessageAt: "2026-10-01T09:00:00.000Z" }),
        shell({ id: "t2", running: true, latestUserMessageAt: "2026-10-01T11:00:00.000Z" }),
      ],
    );
    const columns = groupWorkTaskboard(result.values());
    const working = columns.get("working") ?? [];
    expect(working.map((card) => card.task.id)).toEqual(["busy", "quiet"]);
    expect(working[0]).toMatchObject({ status: "working", latestThread: { id: "t2" } });
    expect(working[1]).toMatchObject({
      latestThread: null,
      activityAt: "2026-10-01T10:00:00.000Z",
    });
    expect(columns.get("needs-you")?.map((card) => card.task.id)).toEqual(["blocked"]);
    expect(columns.get("archive")?.map((card) => card.task.id)).toEqual(["old"]);
    expect(columns.get("in-review")).toEqual([]);
  });
});

describe("linkedWorkTasksByKey", () => {
  it("links live tasks on the same branch and leaves the rest out", () => {
    const api = workTask({ id: "api", branch: "feature/42" });
    const ui = workTask({ id: "ui", branch: "feature/42" });
    const solo = workTask({ id: "solo", branch: "feature/7" });
    const old = workTask({
      id: "old",
      branch: "feature/7",
      archivedAt: "2026-10-01T12:00:00.000Z",
    });
    const linked = linkedWorkTasksByKey([api, ui, solo, old]);
    expect(linked.get(workTaskKey(ENV, api.id))).toEqual([ui]);
    expect(linked.get(workTaskKey(ENV, ui.id))).toEqual([api]);
    expect(linked.has(workTaskKey(ENV, solo.id))).toBe(false);
    expect(linked.has(workTaskKey(ENV, old.id))).toBe(false);
  });
});

function menuItem(
  members: ReadonlyArray<{ id: string; pr?: boolean; branch?: string }>,
  url: string | null = null,
  taskOverrides: Partial<EnvironmentWorkTask> = {},
): WorkTaskItem {
  return {
    key: "item",
    workItem: {
      id: 4242 as never,
      title: "T",
      type: "PBI",
      state: "Active",
      sprint: null,
      url,
      source: "linked",
    },
    title: "T",
    section: "working",
    status: "working",
    unseen: false,
    activityAt: "2026-10-01T09:00:00.000Z",
    members: members.map((member, index) => ({
      view: {
        key: member.id,
        task: workTask({ id: member.id, branch: member.branch ?? "feature/x", ...taskOverrides }),
        tabs: [],
        status: "working",
        pullRequest: member.pr
          ? ({ number: 10 + index, url: `https://pr/${index}` } as never)
          : null,
        latestThread: null,
        activityAt: `2026-10-0${index + 1}T09:00:00.000Z`,
      },
      repo: `repo${index}`,
      label: `repo${index}`,
      insight: null,
      unseen: false,
    })),
  };
}

describe("workTaskItemMenuItems", () => {
  it("lists the item actions in order", () => {
    const items = workTaskItemMenuItems(menuItem([{ id: "a", pr: true }], "https://ado/4242"));
    expect(items.map((item) => item.id)).toEqual([
      "open-ado",
      "copy-id",
      "copy-branch",
      "open-pr:0",
      "new-thread:0",
      "rename",
      "rename-ai",
      "mark-waiting",
      "auto-handle",
      "archive",
    ]);
    expect(items.find((item) => item.id === "copy-id")?.detail).toBe("4242");
  });

  it("disables open-ado without a URL", () => {
    const items = workTaskItemMenuItems(menuItem([{ id: "a" }]));
    expect(items.find((item) => item.id === "open-ado")?.disabled).toBe(true);
  });

  it("offers one open-pr child per member and one new-thread child per member", () => {
    const items = workTaskItemMenuItems(
      menuItem([
        { id: "a", pr: true },
        { id: "b", pr: true },
      ]),
    );
    const prs = items.find((item) => item.id === "open-pr");
    expect(prs?.children?.map((child) => [child.id, child.label])).toEqual([
      ["open-pr:0", "repo0 #10"],
      ["open-pr:1", "repo1 #11"],
    ]);
    expect(items.find((item) => item.id === "new-thread")?.children?.map((c) => c.id)).toEqual([
      "new-thread:0",
      "new-thread:1",
    ]);
  });

  it("flattens open-pr and new-thread for a single member", () => {
    const items = workTaskItemMenuItems(menuItem([{ id: "a", pr: true }]));
    expect(items.filter((i) => i.id === "open-pr:0" || i.id === "new-thread:0")).toEqual([
      { id: "open-pr:0", label: "Open pull request", disabled: false },
      { id: "new-thread:0", label: "New thread", disabled: false },
    ]);
  });

  it("disables open pull request when no member has one", () => {
    const items = workTaskItemMenuItems(menuItem([{ id: "a" }]));
    expect(items.find((item) => item.id === "open-pr:0")?.disabled).toBe(true);
  });

  it("offers clear waiting when a member waits, and keeps linked repos", () => {
    const items = workTaskItemMenuItems(
      menuItem([{ id: "a" }], null, { waitingForUserReason: "Decide" }),
      { linkedProjectTitles: ["Ui"] },
    );
    expect(items.map((item) => item.id)).toContain("clear-waiting");
    expect(items.find((item) => item.id === "open-linked:0")?.label).toBe("Open in Ui");
  });

  it("disables edits when archived or read-only", () => {
    const readOnly = workTaskItemMenuItems(menuItem([{ id: "a", pr: true }], "u"), {
      canOperate: false,
    });
    expect(readOnly.filter((item) => item.disabled).map((item) => item.id)).toEqual([
      "new-thread:0",
      "rename",
      "rename-ai",
      "mark-waiting",
      "auto-handle",
      "archive",
    ]);
  });
});

describe("workTaskOwnsWorktreePath", () => {
  it("matches live tasks, ignoring trailing slashes", () => {
    const tasks = [
      workTask({ id: "live" }),
      workTask({ id: "old", archivedAt: "2026-10-01T12:00:00.000Z" }),
    ];
    expect(workTaskOwnsWorktreePath(tasks, "/tmp/live")).toBe(true);
    expect(workTaskOwnsWorktreePath(tasks, " /tmp/live/ ")).toBe(true);
    expect(workTaskOwnsWorktreePath(tasks, "/tmp/live/sub")).toBe(false);
    expect(workTaskOwnsWorktreePath(tasks, "/tmp/old")).toBe(false);
    expect(workTaskOwnsWorktreePath([], "/tmp/live")).toBe(false);
  });

  it("treats every worktree as owned while the snapshot has not loaded", () => {
    expect(workTaskOwnsWorktreePath(null, "/tmp/anything")).toBe(true);
    const loading = loadedWorkTasks(AsyncResult.initial(true));
    expect(loading).toBeNull();
    expect(workTaskOwnsWorktreePath(loading, "/tmp/anything")).toBe(true);
  });

  it("reads a loaded snapshot, and no tasks once the stream failed", () => {
    const tasks = [workTask({ id: "live" })];
    const loaded = loadedWorkTasks(AsyncResult.success({ tasks, links: [] }));
    expect(workTaskOwnsWorktreePath(loaded, "/tmp/live")).toBe(true);
    expect(workTaskOwnsWorktreePath(loaded, "/tmp/other")).toBe(false);
    const failed = loadedWorkTasks(AsyncResult.failure(Cause.fail("no merge rpc")));
    expect(failed).toEqual([]);
    expect(workTaskOwnsWorktreePath(failed, "/tmp/live")).toBe(false);
  });
});

describe("workTaskTitleFromBranch", () => {
  it("drops the type prefix and keeps a leading issue number", () => {
    expect(workTaskTitleFromBranch("feature/#533-mx2-review")).toBe("#533: mx2 review");
    expect(workTaskTitleFromBranch("fix/login_page--crash")).toBe("login page crash");
    expect(workTaskTitleFromBranch("#12")).toBe("#12");
    expect(workTaskTitleFromBranch("main")).toBe("main");
  });
});

describe("remoteBranchOf", () => {
  it("strips the remote and skips HEAD and local refs", () => {
    const ref = (name: string, isRemote = true) => ({
      name,
      isRemote,
      remoteName: "origin",
      current: false,
      isDefault: false,
      worktreePath: null,
    });
    expect(remoteBranchOf(ref("origin/feature/x"))).toEqual({
      remoteName: "origin",
      branch: "feature/x",
    });
    expect(remoteBranchOf(ref("origin/HEAD"))).toBeNull();
    expect(remoteBranchOf(ref("feature/x", false))).toBeNull();
  });
});

describe("WORK_TASK_STATUS_PRESENTATION", () => {
  it("gives every status a label and a distinct glyph", () => {
    const glyphs = WORK_TASK_STATUSES.map((status) =>
      JSON.stringify(WORK_TASK_STATUS_PRESENTATION[status].glyph),
    );
    expect(new Set(glyphs).size).toBe(WORK_TASK_STATUSES.length);
    for (const status of WORK_TASK_STATUSES) {
      expect(WORK_TASK_STATUS_PRESENTATION[status].label.length).toBeGreaterThan(0);
    }
  });
});

describe("threadsOutsideWorkTasks", () => {
  it("drops task threads and their subagents, and keeps the array when nothing is linked", () => {
    const threads = [
      shell({ id: "task-thread" }),
      shell({ id: "task-child", subagentOf: "task-thread" }),
      shell({ id: "free" }),
    ];
    const keys = workTaskThreadKeys(new Map([[ENV, [link("task-thread", "t1")]]]));
    expect(threadsOutsideWorkTasks(threads, keys).map((thread) => thread.id)).toEqual(["free"]);
    expect(threadsOutsideWorkTasks(threads, workTaskThreadKeys(new Map()))).toBe(threads);
  });
});
