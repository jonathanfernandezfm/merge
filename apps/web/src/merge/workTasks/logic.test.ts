import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  ProjectId,
  WORK_TASK_STATUSES,
  WorkTaskId,
  type ThreadPullRequestLink,
  type WorkTaskLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkTaskViews,
  groupSidebarWorkTasks,
  groupWorkTaskboard,
  linkedWorkTasksByKey,
  remoteBranchOf,
  workTaskboardColumnForStatus,
  workTaskKey,
  workTaskMenuItems,
  workTaskTabState,
  workTaskTitleFromBranch,
  type EnvironmentWorkTask,
  type WorkTaskView,
} from "./logic";
import { WORK_TASK_STATUS_PRESENTATION } from "./statusPresentation";
import { ENV, link, PROJECT, shell, workTask } from "./testFixtures";

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
    expect(view(result, "t").status).toBe("approved");
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
      "ci-running": "in-review",
      "ci-failing": "needs-you",
      "changes-requested": "needs-you",
      "addressing-comments": "working",
      "waiting-for-review": "in-review",
      approved: "ready-to-merge",
      "merge-ready": "ready-to-merge",
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

describe("groupSidebarWorkTasks", () => {
  const OTHER = ProjectId.make("project-2");
  const projects = [
    { environmentId: ENV, id: PROJECT, title: "Api" },
    { environmentId: ENV, id: OTHER, title: "Ui" },
  ];
  const all = views(
    [
      workTask({
        id: "old",
        title: "Permissions",
        branch: "feature/perm",
        createdAt: "2026-10-01T08:00:00.000Z",
        updatedAt: "2026-10-01T12:00:00.000Z",
      }),
      workTask({
        id: "new",
        title: "Login page",
        branch: "feature/login",
        createdAt: "2026-10-01T10:00:00.000Z",
        waitingForUserReason: "Decide",
      }),
      workTask({ id: "archived", archivedAt: "2026-10-01T12:00:00.000Z" }),
      workTask({ id: "ui", projectId: OTHER, title: "Theme", branch: "feature/theme" }),
    ],
    [],
    [],
  );
  const group = (
    overrides: Partial<Parameters<typeof groupSidebarWorkTasks>[0]> = {},
  ): ReadonlyArray<{ title: string; ids: ReadonlyArray<string> }> =>
    groupSidebarWorkTasks({
      views: all.values(),
      projects,
      hiddenProjectKeys: new Set(),
      query: "",
      sort: "newest",
      ...overrides,
    }).map((entry) => ({ title: entry.title, ids: entry.views.map((v) => v.task.id) }));

  it("groups active tasks by project, newest first, without archived ones", () => {
    expect(group()).toEqual([
      { title: "Api", ids: ["new", "old"] },
      { title: "Ui", ids: ["ui"] },
    ]);
  });

  it("sorts by recent activity or by status", () => {
    expect(group({ sort: "activity" })[0]?.ids).toEqual(["old", "new"]);
    // waiting-for-user precedes idle in the lifecycle order.
    expect(group({ sort: "status" })[0]?.ids).toEqual(["new", "old"]);
  });

  it("hides projects, but search reaches hidden projects by title or branch", () => {
    const hidden = new Set([`${ENV}:${OTHER}`]);
    expect(group({ hiddenProjectKeys: hidden }).map((entry) => entry.title)).toEqual(["Api"]);
    expect(group({ hiddenProjectKeys: hidden, query: " THEME " })).toEqual([
      { title: "Ui", ids: ["ui"] },
    ]);
    expect(group({ query: "feature/perm" })).toEqual([{ title: "Api", ids: ["old"] }]);
    expect(group({ query: "nothing" })).toEqual([]);
  });
});

describe("workTaskMenuItems", () => {
  it("offers new thread, linked repos, waiting, auto-handle and archive", () => {
    const items = workTaskMenuItems({
      task: workTask({ id: "t", autoHandleReviewFeedback: false }),
      linkedProjectTitles: ["Ui"],
    });
    expect(items.map((item) => [item.id, item.label])).toEqual([
      ["new-thread", "New thread"],
      ["open-linked:0", "Open in Ui"],
      ["mark-waiting", "Mark waiting for user..."],
      ["auto-handle", "Auto-handle PR feedback"],
      ["archive", "Archive Work Task..."],
    ]);
    expect(items.find((item) => item.id === "auto-handle")?.checked).toBe(false);
  });

  it("offers clear waiting, and disables actions once archived", () => {
    const waiting = workTaskMenuItems({
      task: workTask({ id: "t", waitingForUserReason: "Decide" }),
      linkedProjectTitles: [],
    });
    expect(waiting.map((item) => item.id)).toContain("clear-waiting");
    const archived = workTaskMenuItems({
      task: workTask({ id: "t", archivedAt: "2026-10-01T12:00:00.000Z" }),
      linkedProjectTitles: [],
    });
    expect(archived.filter((item) => item.disabled).map((item) => item.id)).toEqual([
      "new-thread",
      "mark-waiting",
      "auto-handle",
      "archive",
    ]);
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
