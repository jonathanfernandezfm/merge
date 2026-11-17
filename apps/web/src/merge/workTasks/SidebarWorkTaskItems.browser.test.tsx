import "../../index.css";

import type { WorkTaskInsight } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import { render } from "../../../test/render";
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
    fixtures.workTask({ id: "old", title: "Shipped thing", mergedAt: "2026-10-02T09:00:00.000Z" }),
  ];
  const views = logic.buildWorkTaskViews({
    tasks,
    linksByEnvironment: new Map([
      [fixtures.ENV, [fixtures.link("t1", "api"), fixtures.link("t2", "ui")]],
    ]),
    shells: [
      fixtures.shell({ id: "t1", running: true }),
      fixtures.shell({ id: "t2", running: true }),
    ],
  });
  const workItem = { id: 7, title: "Permissions", type: "PBI", state: "Active" };
  const insights = new Map(
    ["api", "ui"].map((id) => [
      logic.workTaskKey(fixtures.ENV, tasks.find((task) => task.id === id)!.id),
      { workItem, pullRequest: null } as unknown as WorkTaskInsight,
    ]),
  );
  const items = groupWorkTaskItems({
    views: [...views.values()],
    insights,
    repoName: ({ task }) => (task.id === "ui" ? "web" : "Acme"),
    unseen: () => false,
  });
  const command = { label: "stub" };
  return {
    useWorkTaskItems: () => items,
    useLinkedWorkTasks: () => new Map(),
    useThreadWorkTask: () => null,
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

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <SidebarWorkTasks />
    </SidebarProvider>,
  );

describe("Work Task items sidebar", () => {
  it("puts attention items above the Working shelf", async () => {
    await using _screen = await renderSidebar();
    const attention = page.getByRole("button", { name: /^Broken setup/ });
    await expect.element(attention).toBeVisible();
    const working = page.getByRole("button", { name: /Working \d/ });
    await expect.element(working).toBeVisible();
    const top = (element: ReturnType<typeof page.getByRole>) =>
      element.element().getBoundingClientRect().top;
    expect(top(attention)).toBeLessThan(top(working));
  });

  it("toggles Done and remembers it across a remount", async () => {
    localStorage.removeItem("merge:work-task-shelves:v1");
    {
      await using _screen = await renderSidebar();
      await expect.element(page.getByText("Shipped thing")).not.toBeInTheDocument();
      await page.getByRole("button", { name: /Done \d/ }).click();
      await expect.element(page.getByText("Shipped thing")).toBeVisible();
    }
    await using _screen = await renderSidebar();
    await expect.element(page.getByText("Shipped thing")).toBeVisible();
  });

  it("shows every repo of a multi-member item on its second line", async () => {
    await using _screen = await renderSidebar();
    const row = page.getByRole("button", { name: /^Permissions,/ });
    await expect.element(row.getByText("Acme")).toBeVisible();
    await expect.element(row.getByText("web")).toBeVisible();
  });
});
