import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import { render } from "../../../test/render";
import { buildWorkTaskViews, workTaskKey } from "./logic";
import { SidebarWorkTasks } from "./SidebarWorkTasks";
import { ENV, link, shell, workTask } from "./testFixtures";
import { WorkTaskChrome } from "./WorkTaskChrome";

// Two tasks on one branch in the same project (linked), one running, one with a failed setup.
vi.mock("./state", async () => {
  const fixtures = await import("./testFixtures");
  const logic = await import("./logic");
  const tasks = [
    fixtures.workTask({ id: "api", title: "Permissions API", branch: "feature/perm" }),
    fixtures.workTask({
      id: "ui",
      title: "Permissions UI",
      branch: "feature/perm",
      setup: "failed",
    }),
  ];
  const views = logic.buildWorkTaskViews({
    tasks,
    linksByEnvironment: new Map([
      [fixtures.ENV, [fixtures.link("t1", "api"), fixtures.link("t2", "api", "review-feedback")]],
    ]),
    shells: [
      fixtures.shell({ id: "t1", running: true, createdAt: "2026-10-01T10:00:00.000Z" }),
      fixtures.shell({ id: "t2", ran: true, createdAt: "2026-10-01T11:00:00.000Z" }),
    ],
  });
  const linked = logic.linkedWorkTasksByKey(tasks);
  const command = { label: "stub" };
  return {
    useWorkTaskViews: () => views,
    useLinkedWorkTasks: () => linked,
    useThreadWorkTask: () => null,
    useWorkTaskView: () => null,
    readLinkedWorkTasks: () => [],
    readWorkTaskView: () => null,
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

describe("Work Tasks UI", () => {
  it("lists active Work Tasks by project with status and the linked-branch count", async () => {
    await using _screen = await render(
      <SidebarProvider>
        <SidebarWorkTasks />
      </SidebarProvider>,
    );
    await expect.element(page.getByText("Work Tasks", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Acme")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Permissions API, Working · feature\/perm/ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Permissions UI, Setup failed · feature\/perm/ }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /Permissions API.*Also in Acme/ }))
      .toBeVisible();
  });

  it("renders the task bar with its header, thread tabs and failed setup", async () => {
    const tasks = [
      workTask({ id: "api", title: "Permissions API", branch: "feature/perm", setup: "failed" }),
    ];
    const views = buildWorkTaskViews({
      tasks,
      linksByEnvironment: new Map([
        [ENV, [link("t1", "api"), link("t2", "api", "review-feedback")]],
      ]),
      shells: [
        shell({ id: "t1", running: true, createdAt: "2026-10-01T10:00:00.000Z" }),
        shell({ id: "t2", ran: true, createdAt: "2026-10-01T11:00:00.000Z" }),
      ],
    });
    const view = views.get(workTaskKey(ENV, tasks[0]!.id))!;
    await using _screen = await render(
      <WorkTaskChrome view={view} activeThreadId={view.tabs[0]!.shell.id} />,
    );
    await expect.element(page.getByRole("heading", { name: "Permissions API" })).toBeVisible();
    await expect.element(page.getByText("Workspace setup failed")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Retry setup" })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Threads in Permissions API" });
    await expect.element(tabs.getByRole("link", { name: "Thread t1, Running" })).toBeVisible();
    await expect
      .element(tabs.getByRole("link", { name: "Thread t2, Idle, Review feedback" }))
      .toBeVisible();
  });
});
