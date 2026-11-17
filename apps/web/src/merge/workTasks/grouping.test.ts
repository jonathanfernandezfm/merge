import { WorkTaskId, type WorkTaskInsight, type WorkTaskStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupWorkTaskItems } from "./grouping";
import { ENV, workTask } from "./testFixtures";
import { workTaskKey, type WorkTaskView } from "./logic";

function view(
  id: string,
  status: WorkTaskStatus,
  overrides: {
    branch?: string;
    titleSource?: "user" | "generated" | "branch";
    createdAt?: string;
    title?: string;
    activityAt?: string;
  } = {},
): WorkTaskView {
  const { activityAt: _activityAt, ...taskOverrides } = overrides;
  const task = workTask({ id, ...taskOverrides });
  return {
    key: workTaskKey(ENV, task.id),
    task,
    tabs: [],
    status,
    pullRequest: null,
    latestThread: null,
    activityAt: overrides.activityAt ?? "2026-10-01T09:00:00.000Z",
  };
}

const insight = (v: WorkTaskView, workItemId: number | null): WorkTaskInsight => ({
  taskId: v.task.id as WorkTaskId,
  workItem:
    workItemId === null
      ? null
      : {
          id: workItemId as never,
          title: "Item",
          type: "PBI",
          state: "Active",
          sprint: null,
          url: null,
          source: "linked",
        },
  pullRequest: null,
});

const group = (views: WorkTaskView[], ids: Record<string, number | null>) =>
  groupWorkTaskItems({
    views,
    insights: new Map(
      views.flatMap((v) =>
        v.task.id in ids ? [[v.key, insight(v, ids[v.task.id]!)] as const] : [],
      ),
    ),
    repoName: (v) => (v.task.workspace.path?.includes("ui") ? "esm-ui" : "esm"),
    unseen: () => false,
  });

describe("groupWorkTaskItems", () => {
  it("groups two tasks of one work item into one review item", () => {
    const items = group([view("esm", "approved"), view("ui", "waiting-for-review")], {
      esm: 1,
      ui: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: `ado:${ENV}:1`,
      section: "review",
      status: "approved",
    });
    expect(items[0]!.members.map((m) => m.label)).toEqual(["esm", "esm-ui"]);
  });

  it("is attention when any member needs the user", () => {
    const [item] = group([view("esm", "approved"), view("ui", "changes-requested")], {
      esm: 1,
      ui: 1,
    });
    expect(item).toMatchObject({ section: "attention", status: "changes-requested" });
  });

  it("labels same-repo members with their branch", () => {
    const [item] = group(
      [view("a", "idle", { branch: "feature/b" }), view("b", "idle", { branch: "feature/a" })],
      { a: 1, b: 1 },
    );
    expect(item!.members.map((m) => m.label)).toEqual(["esm · feature/a", "esm · feature/b"]);
  });

  it("makes each task its own item without insight", () => {
    const items = group([view("a", "idle"), view("b", "idle")], {});
    expect(items.map((i) => i.key).toSorted()).toEqual(
      ["a", "b"].map((id) => `task:${workTaskKey(ENV, WorkTaskId.make(id))}`),
    );
    expect(items).toHaveLength(2);
    expect(group([view("a", "idle")], { a: null })[0]!.workItem).toBeNull();
  });

  it("hides the ADO number in a title the user did not type", () => {
    const [branch] = group([view("a", "working", { title: "#607374: Copy link" })], {});
    expect(branch!.title).toBe("Copy link");
    const [digits] = group([view("b", "working", { title: "#607374: 12" })], {});
    expect(digits!.title).toBe("#607374: 12");
    const [user] = group([view("c", "working", { title: "#1 keep", titleSource: "user" })], {});
    expect(user!.title).toBe("#1 keep");
  });

  it("prefers a user title over a newer generated one", () => {
    const [item] = group(
      [
        view("a", "idle", {
          titleSource: "user",
          title: "Mine",
          createdAt: "2026-10-01T09:00:00.000Z",
        }),
        view("b", "idle", {
          titleSource: "generated",
          title: "Gen",
          createdAt: "2026-10-02T09:00:00.000Z",
        }),
      ],
      { a: 1, b: 1 },
    );
    expect(item!.title).toBe("Mine");
  });

  it("orders by section then newest activity", () => {
    const items = group(
      [
        view("a", "merged", { activityAt: "2026-10-05T00:00:00.000Z" }),
        view("b", "idle", { activityAt: "2026-10-01T00:00:00.000Z" }),
        view("c", "idle", { activityAt: "2026-10-02T00:00:00.000Z" }),
      ],
      {},
    );
    expect(items.map((i) => i.section)).toEqual(["attention", "attention", "done"]);
    expect(items.map((i) => i.activityAt.slice(8, 10))).toEqual(["02", "01", "05"]);
  });
});
