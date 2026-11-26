import "../../index.css";

import type { WorkTaskInsight } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import { render } from "../../../test/render";
import { SidebarNeedsYou } from "../needsYou/SidebarNeedsYou";
import { SidebarWorkTasks } from "./SidebarWorkTasks";

// Needs you (setup failed), two repos on ADO item 7 (running), and one merged task.
vi.mock("./state", async () => {
  const fixtures = await import("./testFixtures");
  const logic = await import("./logic");
  const { groupWorkTaskItems } = await import("./grouping");
  const tasks = [
    fixtures.workTask({ id: "broken", title: "Broken setup", setup: "failed" }),
    fixtures.workTask({ id: "api", title: "Permissions", branch: "feature/api" }),
    fixtures.workTask({ id: "ui", title: "Permissions UI", branch: "feature/ui" }),
    fixtures.workTask({ id: "bad", title: "Mixed", branch: "feature/bad", setup: "failed" }),
    fixtures.workTask({ id: "good", title: "Mixed", branch: "feature/good" }),
    fixtures.workTask({ id: "old", title: "Shipped thing", mergedAt: "2026-10-02T09:00:00.000Z" }),
  ];
  const views = logic.buildWorkTaskViews({
    tasks,
    linksByEnvironment: new Map([
      [
        fixtures.ENV,
        [fixtures.link("t1", "api"), fixtures.link("t2", "ui"), fixtures.link("t3", "good")],
      ],
    ]),
    shells: [
      fixtures.shell({ id: "t1", running: true }),
      fixtures.shell({ id: "t2", running: true }),
      fixtures.shell({ id: "t3", running: true, updatedAt: "2026-10-05T09:00:00.000Z" }),
    ],
  });
  const workItem = { id: 7, title: "Permissions", type: "PBI", state: "Active" };
  const insights = new Map(
    ["api", "ui"].map((id) => [
      logic.workTaskKey(fixtures.ENV, tasks.find((task) => task.id === id)!.id),
      { workItem, pullRequest: null } as unknown as WorkTaskInsight,
    ]),
  );
  const mixed = new Map(
    ["bad", "good"].map((id) => [
      logic.workTaskKey(fixtures.ENV, tasks.find((task) => task.id === id)!.id),
      { workItem: { ...workItem, id: 9 }, pullRequest: null } as unknown as WorkTaskInsight,
    ]),
  );
  const items = groupWorkTaskItems({
    views: [...views.values()],
    insights: new Map([...insights, ...mixed]),
    repoName: ({ task }) => (task.id === "ui" ? "web" : "Acme"),
    unseen: () => false,
  });
  const command = { label: "stub" };
  return {
    useWorkTaskItems: () => items,
    useWorkTaskProjects: () => [],
    useLinkedWorkTasks: () => new Map(),
    useThreadWorkTask: () => null,
    useThreadsOutsideWorkTasks: <T,>(threads: ReadonlyArray<T>) => threads,
    useWorkTaskView: () => null,
    readLinkedWorkTasks: () => [],
    readWorkTaskView: () => null,
    mergeWorkTaskOwnsWorktreePath: () => false,
    useKeepWorkTasksLive: () => undefined,
    workTasksEnvironment: {
      create: command,
      archiveCheck: () => null,
      listBranches: () => null,
      retrySetup: command,
      createThread: command,
      archive: command,
      setWaiting: command,
      setAutoHandle: command,
    },
  };
});

vi.mock("~/state/entities", async (importOriginal) => {
  const fixtures = await import("./testFixtures");
  return {
    ...(await importOriginal<typeof import("~/state/entities")>()),
    useProjects: () => [{ environmentId: fixtures.ENV, id: fixtures.PROJECT, title: "Acme" }],
  };
});

// Lint forbids lifecycle hooks, so the persisted shelves are cleared by disposal.
const freshShelves = () => {
  const clear = () => localStorage.removeItem("merge:work-task-shelves:v1");
  clear();
  return { [Symbol.dispose]: clear };
};

// The Needs you lane holds the attention items, so the sidebar renders it above the section.
const renderSidebar = () =>
  render(
    <SidebarProvider>
      <div>
        <SidebarNeedsYou searchQuery="" scopedProjectKeys={null} />
        <SidebarWorkTasks />
      </div>
    </SidebarProvider>,
  );

describe("Work Task items sidebar", () => {
  it("moves attention items into the Needs you lane, above the Working shelf", async () => {
    await using _screen = await renderSidebar();
    const lane = page.getByRole("region", { name: /^Needs you/ });
    const attention = lane.getByRole("button", { name: /^Broken setup/ });
    await expect.element(attention).toBeVisible();
    expect(page.getByRole("button", { name: /^Broken setup/ }).elements()).toHaveLength(1);
    const working = page.getByRole("button", { name: /^Working \d/ });
    await expect.element(working).toBeVisible();
    const top = (element: ReturnType<typeof page.getByRole>) =>
      element.element().getBoundingClientRect().top;
    expect(top(attention)).toBeLessThan(top(working));
  });

  it("toggles Done and remembers it across a remount", async () => {
    using _shelves = freshShelves();
    {
      await using _screen = await renderSidebar();
      await expect.element(page.getByText("Shipped thing")).not.toBeInTheDocument();
      await page.getByRole("button", { name: /Done \d/ }).click();
      await expect.element(page.getByText("Shipped thing")).toBeVisible();
    }
    await using _screen = await renderSidebar();
    await expect.element(page.getByText("Shipped thing")).toBeVisible();
  });

  it("gives every repo of a multi-member item its own row", async () => {
    await using _screen = await renderSidebar();
    const repos = page.getByRole("list", { name: "Permissions repositories" });
    await expect.element(repos.getByRole("button", { name: /^Acme,/ })).toBeVisible();
    await expect.element(repos.getByRole("button", { name: /^web,/ })).toBeVisible();
  });

  it("describes the same member whose status the row shows", async () => {
    await using _screen = await renderSidebar();
    // The setup-failed member leads, though the running one was touched last.
    await expect
      .element(page.getByRole("button", { name: /^Mixed, Setup failed · feature\/bad/ }))
      .toBeVisible();
  });
});
