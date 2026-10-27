import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { SidebarProvider } from "~/components/ui/sidebar";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { render } from "../../../test/render";
import { FolderDialogsHost } from "./FolderDialogs";
import { SidebarFolders } from "./SidebarFolders";

const runFolderCommand = vi.hoisted(() => vi.fn(async () => ({ folderId: "new" })));

vi.mock("./state", async () => {
  const fixtures = await import("../workTasks/testFixtures");
  const logic = await import("./logic");
  const { FolderId, ThreadId } = await import("@t3tools/contracts");
  const folder = (id: string, title: string) => ({
    environmentId: fixtures.ENV,
    id: FolderId.make(id),
    title,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  });
  const folders = [folder("parked", "Parked"), folder("later", "Later")];
  const filed = logic.filedThreadKeys(
    folders,
    new Map([
      [fixtures.ENV, [{ threadId: ThreadId.make("t1"), folderId: FolderId.make("parked") }]],
    ]),
  );
  const shells = [fixtures.shell({ id: "t1" }), fixtures.shell({ id: "t2" })].map((shell) => ({
    ...shell,
    projectId: fixtures.PROJECT,
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
  }));
  const command = { label: "stub" };
  return {
    useFolderViews: (scopedProjectKeys: ReadonlySet<string> | null) =>
      logic.buildFolderViews({ folders, filed, shells, scopedProjectKeys }),
    useFolderEnvironments: () => [fixtures.ENV],
    readFolderMenuItems: () => [],
    runFolderCommand,
    foldersEnvironment: { create: command, rename: command, delete: command, assign: command },
  };
});

const openMenu = vi.hoisted(() => vi.fn());
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu, closeMenu: () => undefined }),
}));

vi.mock("~/state/environments", async (importOriginal) => {
  const fixtures = await import("../workTasks/testFixtures");
  return {
    ...(await importOriginal<typeof import("~/state/environments")>()),
    usePrimaryEnvironmentId: () => fixtures.ENV,
  };
});

describe("SidebarFolders", () => {
  it("lists folders with their filed threads and creates a folder", async () => {
    // Folder open state lives in localStorage.
    localStorage.clear();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SidebarFolders />
          <FolderDialogsHost />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Folders", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Later, 0 threads" })).toBeVisible();
    await page.getByRole("button", { name: "Parked, 1 threads" }).click();
    await expect.element(page.getByRole("button", { name: /Thread t1/ })).toBeVisible();
    await expect.element(page.getByText("Thread t2")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByRole("dialog").getByLabelText("Name").fill("Someday");
    await page.getByRole("button", { name: "Create" }).click();
    await vi.waitFor(() =>
      expect(runFolderCommand).toHaveBeenCalledWith(
        { label: "stub" },
        { environmentId: "env-1", input: { title: "Someday" } },
        "Could not create the folder",
      ),
    );
  });

  it("hides while searching and opens the full thread menu on a filed thread", async () => {
    localStorage.clear();
    await using screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SidebarFolders searchQuery="thread" />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Folders", { exact: true })).not.toBeInTheDocument();
    await screen.rerender(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <SidebarFolders />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
    );
    await page.getByRole("button", { name: "Parked, 1 threads" }).click();
    await page.getByRole("button", { name: /Thread t1/ }).click({ button: "right" });
    expect(openMenu).toHaveBeenCalledOnce();
  });
});
